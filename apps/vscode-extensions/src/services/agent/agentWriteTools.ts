import * as vscode from 'vscode';
import * as path from 'path';
import {
  NamedRoot,
  WorkspaceRootRequiredError,
  resolveAgainstRoots,
} from '../codebase/codebaseTools';

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

export interface EditFileArgs {
  path: string;
  /** Exact existing text to replace (must be unique in the file unless replaceAll). */
  oldString: string;
  newString: string;
  /** Replace every occurrence instead of requiring uniqueness. */
  replaceAll?: boolean;
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

function assertWritable(roots: NamedRoot[], relOrPrefixed: string): { uri: vscode.Uri; displayPath: string } {
  if (!roots.length) throw new WorkspaceRootRequiredError();
  const resolved = resolveAgainstRoots(roots, relOrPrefixed);
  if (!resolved) throw new Error(`Cannot resolve path "${relOrPrefixed}" against the workspace.`);

  const rootFsPath = resolved.root.uri.fsPath;
  const absPath = path.resolve(rootFsPath, resolved.relPath);
  if (absPath !== rootFsPath && !absPath.startsWith(rootFsPath + path.sep)) {
    throw new Error('Path resolves outside the workspace root — refusing to write.');
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

// ── prepare phase ──

export async function prepareEditFile(args: EditFileArgs, roots: NamedRoot[]): Promise<PreparedWrite> {
  if (!args.oldString) throw new Error('oldString must be non-empty. To create a new file use create_file.');
  if (args.oldString === args.newString) throw new Error('oldString and newString are identical — nothing to change.');
  const { uri, displayPath } = assertWritable(roots, args.path);

  let before: string;
  try {
    before = await documentText(uri);
  } catch {
    throw new Error(`File not found: ${args.path}. Use create_file for new files, or check the path with list_directory.`);
  }
  if (Buffer.byteLength(before, 'utf8') > MAX_WRITE_BYTES) {
    throw new Error(`File exceeds the ${MAX_WRITE_BYTES / 1024}KB agent-edit limit.`);
  }

  const occurrences = countOccurrences(before, args.oldString);
  if (occurrences === 0) {
    throw new Error(
      'oldString was not found in the file. It must match the current file content EXACTLY, ' +
        'including whitespace and indentation. Re-read the file and copy the text verbatim.'
    );
  }
  if (occurrences > 1 && !args.replaceAll) {
    throw new Error(
      `oldString appears ${occurrences} times in the file — include more surrounding lines to make it unique, ` +
        'or pass replaceAll: true to change every occurrence.'
    );
  }

  const after = args.replaceAll ? before.split(args.oldString).join(args.newString) : before.replace(args.oldString, args.newString);
  const n = args.replaceAll ? occurrences : 1;
  return {
    kind: 'edit',
    displayPath,
    uri,
    before,
    after,
    summary: `Edit ${displayPath} (${n} replacement${n === 1 ? '' : 's'})`,
  };
}

export async function prepareCreateFile(args: CreateFileArgs, roots: NamedRoot[]): Promise<PreparedWrite> {
  const { uri, displayPath } = assertWritable(roots, args.path);
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
  const { uri, displayPath } = assertWritable(roots, args.path);
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
    await doc.save();
  }
}
