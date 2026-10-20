import * as fs from 'fs';
import * as path from 'path';
import { NamedRoot, resolveAgainstRoots } from '../codebase/codebaseTools';

/**
 * Project rules injection (A9): read the workspace's agent-instruction files
 * and merge them into one block for the system prompt. We read competitors'
 * config files too — users migrating from Cursor/Claude Code get their
 * existing rules honored with zero setup, which is free onboarding.
 *
 * Precedence: our own file first, then the ecosystem ones; all are included
 * (they rarely conflict — teams keep one), each capped so a huge CLAUDE.md
 * can't crowd out the actual task.
 *
 * Every workspace root contributes, in root order, each under its own label
 * (Codex reads AGENTS.md root→cwd under a 32 KB budget; we match the budget).
 * Subfolder AGENTS.md / CLAUDE.md files are not in the prompt: like Claude
 * Code, they load lazily the first time a tool touches a path under their
 * folder, and ride on that tool result so the cached prompt prefix never
 * changes mid-run (see subfolderRulesFor).
 */

const RULES_FILES = [
  '.workspacegpt/rules.md',
  'CLAUDE.md',
  '.cursorrules',
  'AGENTS.md',
  '.github/copilot-instructions.md',
];

/** Files a subfolder may carry for the code under it — the two the reference tools scope by directory. */
const SUBFOLDER_RULES_FILES = ['AGENTS.md', 'CLAUDE.md'];

export const MAX_PER_FILE_CHARS = 8_000;
export const MAX_TOTAL_CHARS = 32_000;
/** Budget for everything subfolder files add over one run, on top of the prompt's. */
export const MAX_SUBFOLDER_TOTAL_CHARS = 32_000;

/** Reads one rules file, trimmed and clipped to `budget`; undefined if missing or empty. */
function readClipped(abs: string, budget: number): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(abs, 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!content || budget <= 0) return undefined;
  let clipped = content.slice(0, Math.min(MAX_PER_FILE_CHARS, budget));
  if (clipped.length < content.length) clipped += '\n… (truncated)';
  return clipped;
}

export function loadWorkspaceRules(roots: NamedRoot[]): string | undefined {
  const blocks: string[] = [];
  let total = 0;

  for (const root of roots) {
    const sections: string[] = [];
    for (const rel of RULES_FILES) {
      if (total >= MAX_TOTAL_CHARS) break;
      const clipped = readClipped(path.join(root.uri.fsPath, rel), MAX_TOTAL_CHARS - total);
      if (!clipped) continue;
      total += clipped.length;
      sections.push(`From \`${rel}\`:\n${clipped}`);
    }
    if (sections.length) blocks.push(`Folder \`${root.name}\`:\n\n${sections.join('\n\n')}`);
  }

  return blocks.length ? blocks.join('\n\n') : undefined;
}

/** Which subfolder rules one run has already been given. Make a fresh one per run. */
export interface SubfolderRulesState {
  /** Absolute directories already checked — loaded, or found to have no rules file. */
  dirs: Set<string>;
  chars: number;
}

export function newSubfolderRulesState(): SubfolderRulesState {
  return { dirs: new Set(), chars: 0 };
}

/** Tools whose `path` argument means the agent is now working in that folder. */
export const SUBFOLDER_RULES_TOOLS = new Set(['read_file', 'list_directory', 'edit_file', 'create_file', 'delete_file']);

/**
 * The AGENTS.md / CLAUDE.md files in folders between a root and `toolPath`
 * that this run has not been given yet, outermost first, each under a header
 * naming its folder. The root's own files are excluded: they are already in
 * the prompt. Marks every folder it checks, so each file arrives once per run.
 * `isDir` says `toolPath` is itself a folder (list_directory), whose own
 * rules then apply too.
 */
export function subfolderRulesFor(
  roots: NamedRoot[],
  toolPath: unknown,
  isDir: boolean,
  state: SubfolderRulesState
): string | undefined {
  if (!roots.length || typeof toolPath !== 'string' || !toolPath.trim()) return undefined;
  const resolved = resolveAgainstRoots(roots, toolPath.trim());
  if (!resolved) return undefined;
  const rootFs = path.resolve(resolved.root.uri.fsPath);
  const target = path.resolve(rootFs, resolved.relPath);
  const rel = path.relative(rootFs, isDir ? target : path.dirname(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;

  const sections: string[] = [];
  let dir = rootFs;
  for (const part of rel.split(path.sep)) {
    dir = path.join(dir, part);
    if (state.dirs.has(dir)) continue;
    state.dirs.add(dir);
    const label = `${roots.length > 1 ? `${resolved.root.name}/` : ''}${path.relative(rootFs, dir).split(path.sep).join('/')}`;
    for (const name of SUBFOLDER_RULES_FILES) {
      const clipped = readClipped(path.join(dir, name), MAX_SUBFOLDER_TOTAL_CHARS - state.chars);
      if (!clipped) continue;
      state.chars += clipped.length;
      sections.push(`From \`${label}/${name}\` (applies to files under \`${label}/\`; follow it there, it overrides the root rules):\n${clipped}`);
    }
  }
  return sections.length ? sections.join('\n\n') : undefined;
}
