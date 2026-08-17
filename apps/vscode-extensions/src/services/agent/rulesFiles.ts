import * as fs from 'fs';
import * as path from 'path';
import { NamedRoot } from '../codebase/codebaseTools';

/**
 * Project rules injection (A9): read the workspace's agent-instruction files
 * and merge them into one block for the system prompt. We read competitors'
 * config files too — users migrating from Cursor/Claude Code get their
 * existing rules honored with zero setup, which is free onboarding.
 *
 * Precedence: our own file first, then the ecosystem ones; all are included
 * (they rarely conflict — teams keep one), each capped so a huge CLAUDE.md
 * can't crowd out the actual task.
 */

const RULES_FILES = [
  '.workspacegpt/rules.md',
  'CLAUDE.md',
  '.cursorrules',
  'AGENTS.md',
  '.github/copilot-instructions.md',
];

const MAX_PER_FILE_CHARS = 4_000;
const MAX_TOTAL_CHARS = 8_000;

export function loadWorkspaceRules(roots: NamedRoot[]): string | undefined {
  if (!roots.length) return undefined;
  const rootFs = roots[0].uri.fsPath;
  const sections: string[] = [];
  let total = 0;

  for (const rel of RULES_FILES) {
    if (total >= MAX_TOTAL_CHARS) break;
    const abs = path.join(rootFs, rel);
    let content: string;
    try {
      content = fs.readFileSync(abs, 'utf8').trim();
    } catch {
      continue;
    }
    if (!content) continue;
    let clipped = content.slice(0, Math.min(MAX_PER_FILE_CHARS, MAX_TOTAL_CHARS - total));
    if (clipped.length < content.length) clipped += '\n… (truncated)';
    total += clipped.length;
    sections.push(`From \`${rel}\`:\n${clipped}`);
  }

  return sections.length ? sections.join('\n\n') : undefined;
}
