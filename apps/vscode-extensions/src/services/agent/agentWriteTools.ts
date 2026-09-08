import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  NamedRoot,
  WorkspaceRootRequiredError,
  resolveAgainstRoots,
} from '../codebase/codebaseTools';
import { stripLineNumbers } from '../codebase/lineNumbers';

/**
 * Agent WRITE tools (edit_file / create_file / delete_file) — the first tools
 * in this codebase that mutate the workspace, so the shape is deliberately
 * two-phase:
 *
 *   prepare*()  — validate everything and produce a PreparedWrite describing
 *                 exactly what would change. Touches nothing.
 *   applyWrite() — perform a PreparedWrite via WorkspaceEdit (native undo,
 *                 open editors update in place), then save.
 *
 * The approval gate in chatService sits between the two phases: the model's
 * tool call produces a PreparedWrite, the user reviews it in the webview, and
 * only an approval executes applyWrite. Guards (workspace boundary, secret
 * files, size caps) run in prepare so a hostile/confused tool call is rejected
 * before the user is even asked.
 *
 * edit_file semantics mirror the eval-verified search/replace rules
 * (packages/agent-evals): the old text must match EXACTLY and UNIQUELY —
 * ambiguity or a miss is an error fed back to the model, never a guess.
 */

// ── Tool argument shapes (mirrored in modelWorker.ts's TOOL_DEFS) ──

export interface EditReplacement {
  /** Exact existing text to replace (must be unique in the file unless replaceAll). */
  oldString: string;
  newString: string;
  /** Replace every occurrence instead of requiring uniqueness. */
  replaceAll?: boolean;
}

export interface EditFileArgs extends Partial<EditReplacement> {
  path: string;
  /**
   * Several replacements to the same file in one call, applied in order —
   * one edit_file call per FILE instead of one model turn per change (a live
   * run spent four turns on four edits to one test file).
   */
  edits?: EditReplacement[];
}

export interface CreateFileArgs {
  path: string;
  content: string;
}

export interface DeleteFileArgs {
  path: string;
}

/** A fully validated, not-yet-applied write. */
export interface PreparedWrite {
  kind: 'edit' | 'create' | 'delete';
  /** Path as the model referred to it (workspace-relative, possibly root-prefixed). */
  displayPath: string;
  uri: vscode.Uri;
  /** Full document content before/after — the diff card and applyWrite both use these. */
  before: string;
  after: string;
  /** One-line human summary for the review card / audit log. */
  summary: string;
}

// ── Guards ──

const MAX_WRITE_BYTES = 1024 * 1024;

/**
 * Files an agent must never write, regardless of approval — secrets and
 * credential stores. Checked against the basename.
 */
const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\..*)?$/i,
  /^credentials.*\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
];

const isWithin = (parent: string, candidate: string): boolean =>
  candidate === parent || candidate.startsWith(parent + path.sep);

/**
 * Resolve the closest existing ancestor of a path. This is needed for creates,
 * whose leaf does not exist yet, so checking only the leaf's realpath would
 * miss a symlinked parent directory.
 */
async function nearestExistingPath(target: string): Promise<string> {
  let probe = target;
  while (true) {
    try {
      await fs.promises.lstat(probe);
      return probe;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`No existing parent found for "${target}".`);
      probe = parent;
    }
  }
}

/**
 * A lexical `path.resolve` check blocks ../ traversal but not symlinks. Resolve
 * both the workspace and the target (or its existing parent for a create) so a
 * workspace link to another directory can never be used as an agent write path.
 */
async function assertWritable(roots: NamedRoot[], relOrPrefixed: string): Promise<{ uri: vscode.Uri; displayPath: string }> {
  if (!roots.length) throw new WorkspaceRootRequiredError();
  const resolved = resolveAgainstRoots(roots, relOrPrefixed);
  if (!resolved) throw new Error(`Cannot resolve path "${relOrPrefixed}" against the workspace.`);

  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (!isWithin(rootFsPath, absPath)) {
    throw new Error('Path resolves outside the workspace root — refusing to write.');
  }
  const [realRoot, realTarget] = await Promise.all([
    fs.promises.realpath(rootFsPath),
    fs.promises.realpath(await nearestExistingPath(absPath)),
  ]);
  if (!isWithin(realRoot, realTarget)) {
    throw new Error('Path resolves outside the real workspace through a symlink — refusing to write.');
  }
  if (absPath.split(path.sep).includes('.git')) {
    throw new Error('Refusing to write inside a .git directory.');
  }
  const base = path.basename(absPath);
  if (SECRET_FILE_PATTERNS.some((re) => re.test(base))) {
    throw new Error(`Refusing to write "${base}" — secret/credential files are blocked for agent writes.`);
  }
  return { uri: vscode.Uri.file(absPath), displayPath: relOrPrefixed.replace(/^\.?\//, '') };
}

/**
 * Current text of the file as the EDITOR sees it (including unsaved changes),
 * not as the disk sees it — otherwise an edit validated against stale disk
 * content would clobber the user's unsaved work on apply.
 */
async function documentText(uri: vscode.Uri): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return doc.getText();
}

const countOccurrences = (haystack: string, needle: string): number =>
  needle === '' ? 0 : haystack.split(needle).length - 1;

/**
 * Best-effort locator for a mis-copied oldString: finds the file line most
 * similar to oldString's first line and returns that region verbatim (a bit
 * longer than the target), so the caller can copy real bytes instead of
 * guessing again. Null when nothing plausibly matches.
 */
function closestSnippet(content: string, oldString: string): string | null {
  const firstTarget = oldString
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0];
  if (!firstTarget) return null;
  const targetTokens = new Set(firstTarget.split(/\W+/).filter((w) => w.length > 2));
  const fileLines = content.split('\n');
  let bestIdx = -1;
  let bestScore = 0;
  fileLines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    let score = 0;
    if (t === firstTarget) score = 1000;
    else for (const w of t.split(/\W+/)) if (targetTokens.has(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  if (bestIdx < 0 || bestScore < 2) return null;
  const targetLineCount = oldString.split('\n').length;
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(fileLines.length, bestIdx + Math.max(targetLineCount + 2, 5));
  return fileLines.slice(start, end).join('\n');
}

/**
 * Whitespace-tolerant fallback for a missed exact match. The dominant weak-model
 * failure (measured: ~2/3 of edit_file calls failing in agent-evals s2/s3) is
 * writing oldString from memory with the right characters but the wrong layout —
 * typically a multi-line function collapsed onto one line — even immediately
 * after read_file returned the real text. The non-whitespace content is intact,
 * so match on that: escape oldString for regex, then let every whitespace run
 * match any whitespace run. Never loosens WHAT is matched, only HOW it is laid out.
 */
function flexibleMatches(content: string, oldString: string): { index: number; text: string }[] {
  const trimmed = oldString.trim();
  if (!trimmed) return [];
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return [];
  }
  const matches: { index: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    matches.push({ index: m.index, text: m[0] });
    if (matches.length > 8) break; // enough to know it's hopelessly ambiguous
  }
  return matches;
}

/**
 * Re-lays newString onto the REAL matched region's whitespace skeleton, so a
 * flexible match doesn't flatten a multi-line region into the model's one-liner.
 * Only safe for substitution-style edits — same token count AND most tokens
 * unchanged in place (renames, operator fixes, literal swaps). A structural
 * rewrite can coincidentally have the same token count, but pouring it into
 * the old region's line breaks produces arbitrary mid-statement wrapping;
 * null means "can't do this faithfully" and the caller must not guess.
 */
function reflowReplacement(matchedText: string, oldString: string, newString: string): string | null {
  const oldTokens = oldString.trim().split(/\s+/);
  const newTokens = newString.trim().split(/\s+/);
  if (newTokens.length !== oldTokens.length) return null;
  const differing = newTokens.filter((t, i) => t !== oldTokens[i]).length;
  if (differing > Math.max(1, Math.floor(newTokens.length / 2))) return null;
  let ti = 0;
  const rebuilt = matchedText
    .split(/(\s+)/)
    .map((part) => (part === '' || /^\s+$/.test(part) ? part : newTokens[ti++]))
    .join('');
  return ti === newTokens.length ? rebuilt : null;
}

/**
 * One ready-to-copy block per occurrence: the raw file lines from the nearest
 * non-blank line above the occurrence through its end. Handing the model a
 * complete disambiguated oldString to copy is what works — "extend oldString
 * with the preceding line" as an instruction sent qwen into a loop of
 * re-reading the file and retrying the identical ambiguous string (observed
 * across agent-evals s3 runs: 2 ambiguity errors, 12 thrash calls, no fix).
 */
function occurrenceSnippets(content: string, needle: string, cap = 3): string[] {
  const rawLines = content.split('\n');
  const needleLineCount = needle.split('\n').length;
  const out: string[] = [];
  let from = 0;
  for (let n = 0; n < cap; n++) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    const startLine = content.slice(0, idx).split('\n').length - 1;
    let ctxStart = Math.max(0, startLine - 1);
    while (ctxStart > 0 && !rawLines[ctxStart].trim()) ctxStart--;
    const endLine = startLine + needleLineCount - 1;
    out.push(rawLines.slice(ctxStart, endLine + 1).join('\n'));
    from = idx + needle.length;
  }
  return out;
}

// ── prepare phase ──

export async function prepareEditFile(args: EditFileArgs, roots: NamedRoot[]): Promise<PreparedWrite> {
  const edits: EditReplacement[] = args.edits?.length
    ? args.edits
    : [{ oldString: args.oldString ?? '', newString: args.newString ?? '', replaceAll: args.replaceAll }];
  edits.forEach((e, i) => {
    const at = edits.length > 1 ? `edits[${i}]: ` : '';
    if (!e || typeof e.oldString !== 'string' || !e.oldString) throw new Error(`${at}oldString must be non-empty. To create a new file use create_file.`);
    if (typeof e.newString !== 'string') throw new Error(`${at}newString must be a string.`);
    if (e.oldString === e.newString) throw new Error(`${at}oldString and newString are identical — nothing to change.`);
  });
  const { uri, displayPath } = await assertWritable(roots, args.path);

  let before: string;
  try {
    before = await documentText(uri);
  } catch {
    throw new Error(`File not found: ${args.path}. Use create_file for new files, or check the path with list_directory.`);
  }
  if (Buffer.byteLength(before, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`File exceeds the ${MAX_WRITE_BYTES / 1024}KB agent-edit limit.`);
  }

  let after = before;
  let total = 0;
  const notes: string[] = [];
  for (let i = 0; i < edits.length; i++) {
    try {
      const r = applyOneEdit(after, edits[i], displayPath);
      after = r.after;
      total += r.n;
      if (r.note) notes.push(r.note);
    } catch (e) {
      if (edits.length === 1) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `edits[${i}] failed (${i} earlier edit${i === 1 ? '' : 's'} in this call would have applied; NONE were written — fix this entry and resend the whole call): ${msg}`
      );
    }
  }
  return {
    kind: 'edit',
    displayPath,
    uri,
    before,
    after,
    summary: `Edit ${displayPath} (${total} replacement${total === 1 ? '' : 's'}${notes.length ? ` — ${notes.join('; ')}` : ''})`,
  };
}

/** One search/replace against `before`; throws model-actionable errors on miss/ambiguity. */
function applyOneEdit(before: string, args: EditReplacement, displayPath: string): { after: string; n: number; note?: string } {
  let occurrences = countOccurrences(before, args.oldString);
  let denumberedPrefixes = false;
  // read_file output is line-numbered ("  12→code"), and the instruction to
  // drop the prefix when copying into oldString is exactly the kind a model
  // forgets on turn 25. Undo it in code instead: digits are not whitespace,
  // so the whitespace-tolerant rescue below could never recover this, and the
  // edit would fail with a confusing "not found verbatim" on text the model
  // copied faithfully. stripLineNumbers only acts when EVERY non-blank line
  // carries the prefix, so code containing a stray arrow is untouched.
  if (occurrences === 0) {
    const denumbered = stripLineNumbers(args.oldString);
    if (denumbered !== args.oldString && countOccurrences(before, denumbered) > 0) {
      denumberedPrefixes = true;
      args = {
        ...args,
        oldString: denumbered,
        // The replacement was copied from the same numbered output, so it
        // carries the same prefixes — and writing those into the file would
        // corrupt it.
        newString: stripLineNumbers(args.newString),
      };
      occurrences = countOccurrences(before, args.oldString);
    }
  }
  if (occurrences === 0) {
    // Whitespace-tolerant rescue before erroring: if the file contains exactly
    // ONE region whose non-whitespace content equals oldString's, the model
    // meant that region — apply the edit there, re-laid onto the region's real
    // formatting when possible. Turn budgets on local models are tight enough
    // that converting this from an error round-trip into a success is what
    // moves the eval pass rate (see packages/agent-evals, scenarios s2/s3).
    const flex = flexibleMatches(before, args.oldString);
    if (flex.length === 1) {
      const { index, text: matchedText } = flex[0];
      const replacement = reflowReplacement(matchedText, args.oldString, args.newString);
      if (replacement !== null && replacement !== matchedText) {
        const after = before.slice(0, index) + replacement + before.slice(index + matchedText.length);
        // Read by the model (tool result), the user (review card), and the
        // audit log alike — states plainly that the match was not verbatim.
        return {
          after,
          n: 1,
          note: "oldString did not match the file's whitespace/line breaks verbatim; matched ignoring layout, applied with the file's original formatting preserved",
        };
      }
      // Unique region found but new/old token counts differ — re-flowing the
      // replacement faithfully is impossible, and inserting the model's
      // (likely collapsed) newString as-is could corrupt layout-sensitive
      // code. Hand back the real bytes instead: the retry is then a plain
      // copy job, and differs from this call so the repeat short-circuit
      // in modelWorker won't block it.
      throw new Error(
        'oldString was not found verbatim, but exactly one region of the file matches it when whitespace is ignored. ' +
          `That region ACTUALLY reads:\n\`\`\`\n${matchedText}\n\`\`\`\n` +
          'Retry with oldString copied EXACTLY from this snippet (same line breaks and indentation), ' +
          'and write newString as full lines in the same multi-line style.'
      );
    }
    if (flex.length > 1) {
      throw new Error(
        `oldString was not found verbatim, and ignoring whitespace it matches ${flex.length} places in the file — ambiguous. ` +
          'Re-read the file and copy a LONGER snippet EXACTLY (including line breaks and the line above your target) that identifies the ONE place you mean.'
      );
    }
    // Stitched-span detection: every line of oldString exists in the file, in
    // order, but with real code between them that oldString omits — the model
    // concatenated non-adjacent regions (recurring signature: a function
    // definition + the module.exports line, skipping the code between). The
    // generic "copy verbatim" hint can't fix that; naming the actual problem
    // and demanding one edit per region can.
    const oldLines = args.oldString.split('\n').map((l) => l.trim()).filter(Boolean);
    if (oldLines.length >= 2) {
      const rawFileLines = before.split('\n');
      const trimmedFileLines = rawFileLines.map((l) => l.trim());
      const positions: number[] = [];
      let cursor = 0;
      for (const ol of oldLines) {
        const idx = trimmedFileLines.indexOf(ol, cursor);
        if (idx === -1) {
          positions.length = 0;
          break;
        }
        positions.push(idx);
        cursor = idx + 1;
      }
      const hasContentBetween = (a: number, b: number): boolean => {
        for (let j = a + 1; j < b; j++) if (trimmedFileLines[j]) return true;
        return false;
      };
      if (positions.length === oldLines.length && positions.some((p, i) => i > 0 && hasContentBetween(positions[i - 1], p))) {
        // Quote the first contiguous region verbatim so edit #1 is a copy job.
        let firstEnd = 0;
        while (firstEnd + 1 < positions.length && !hasContentBetween(positions[firstEnd], positions[firstEnd + 1])) firstEnd++;
        const firstRegion = rawFileLines.slice(positions[0], positions[firstEnd] + 1).join('\n');
        throw new Error(
          'oldString stitches together NON-ADJACENT parts of the file — its lines all exist, but the file has other code between them that your oldString skips over. ' +
            'Make a SEPARATE entry in edits[] (or a separate edit_file call) for EACH contiguous region. The first region actually reads:\n' +
            `\`\`\`\n${firstRegion}\n\`\`\`\nStart by editing exactly that, then add further entries for the other region(s).`
        );
      }
    }
    // Include the closest real region of the file in the error: weak models
    // write oldString from memory (e.g. a collapsed one-liner of a multi-line
    // function) even right after reading the file — handing them the exact
    // bytes to copy is what actually breaks that habit.
    const snippet = closestSnippet(before, args.oldString);
    throw new Error(
      'oldString was not found in the file. It must match the current file content EXACTLY, ' +
        'including whitespace, indentation, and line breaks.' +
        (snippet
          ? ` The closest matching region of the actual file is:\n\`\`\`\n${snippet}\n\`\`\`\nCopy oldString EXACTLY from this — including its line breaks.`
          : ` The text does not appear in ${displayPath} at all, even ignoring whitespace — you may be editing the WRONG FILE ` +
            '(e.g. trying to change a definition in a file that only imports it). Use search_codebase to find which file actually contains this text, then read_file THAT file and copy oldString exactly.')
    );
  }
  if (occurrences > 1 && !args.replaceAll) {
    // Deliberately does NOT lead with replaceAll: smaller models take the
    // first suggestion, and blanket-replacing shared text (e.g. two functions
    // with identical bodies) corrupts unrelated code. Observed live with qwen.
    // Each occurrence is shown as a complete, copy-ready block (context line
    // included) so the retry is a copy job, not a construction job.
    const snippets = occurrenceSnippets(before, args.oldString);
    throw new Error(
      `oldString appears ${occurrences} times in the file — ambiguous. To change ONE of them, retry with oldString set to the ENTIRE block below for the occurrence you mean (copied EXACTLY, all lines), and newString to that same block with your change applied:\n` +
        snippets.map((s, i) => `${i + 1})\n\`\`\`\n${s}\n\`\`\``).join('\n') +
        (occurrences > snippets.length ? `\n(${occurrences - snippets.length} more occurrence(s) not shown)` : '') +
        '\nOnly if you genuinely intend to change every occurrence, pass replaceAll: true instead.'
    );
  }

  const after = args.replaceAll ? before.split(args.oldString).join(args.newString) : before.replace(args.oldString, args.newString);
  return {
    after,
    n: args.replaceAll ? occurrences : 1,
    ...(denumberedPrefixes
      ? { note: "oldString carried read_file's line-number prefixes; they were stripped before matching (copy the code without the \"12→\" prefix next time)" }
      : {}),
  };
}

export async function prepareCreateFile(args: CreateFileArgs, roots: NamedRoot[]): Promise<PreparedWrite> {
  const { uri, displayPath } = await assertWritable(roots, args.path);
  if (Buffer.byteLength(args.content ?? '', 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`Content exceeds the ${MAX_WRITE_BYTES / 1024}KB agent-write limit.`);
  }
  let exists = true;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    exists = false;
  }
  if (exists) {
    throw new Error(`File already exists: ${args.path}. Use edit_file to modify it.`);
  }
  return {
    kind: 'create',
    displayPath,
    uri,
    before: '',
    after: args.content ?? '',
    summary: `Create ${displayPath} (${(args.content ?? '').split('\n').length} lines)`,
  };
}

export async function prepareDeleteFile(args: DeleteFileArgs, roots: NamedRoot[]): Promise<PreparedWrite> {
  const { uri, displayPath } = await assertWritable(roots, args.path);
  let before: string;
  try {
    before = await documentText(uri);
  } catch {
    throw new Error(`File not found: ${args.path}.`);
  }
  return {
    kind: 'delete',
    displayPath,
    uri,
    before,
    after: '',
    summary: `Delete ${displayPath}`,
  };
}

// ── apply phase ──

/**
 * Perform an approved write. WorkspaceEdit keeps native undo and refreshes any
 * open editor; the explicit save keeps disk (what builds/tests see) in sync
 * with the buffer.
 */
export async function applyWrite(w: PreparedWrite): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  if (w.kind === 'create') {
    edit.createFile(w.uri, { ignoreIfExists: false });
    edit.insert(w.uri, new vscode.Position(0, 0), w.after);
  } else if (w.kind === 'delete') {
    edit.deleteFile(w.uri);
  } else {
    const doc = await vscode.workspace.openTextDocument(w.uri);
    if (doc.getText() !== w.before) {
      throw new Error(`${w.displayPath} changed since the edit was prepared — re-read the file and try again.`);
    }
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(w.before.length));
    edit.replace(w.uri, fullRange, w.after);
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) throw new Error(`VS Code rejected the workspace edit for ${w.displayPath}.`);

  if (w.kind !== 'delete') {
    const doc = await vscode.workspace.openTextDocument(w.uri);
    const saved = await doc.save();
    if (!saved) {
      throw new Error(`Could not save ${w.displayPath}; the edit remains in the editor but was not written to disk.`);
    }
  }
}
