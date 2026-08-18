// ../../apps/vscode-extensions/src/services/agent/rulesFiles.ts
import * as fs from "fs";
import * as path from "path";
var RULES_FILES = [
  ".workspacegpt/rules.md",
  "CLAUDE.md",
  ".cursorrules",
  "AGENTS.md",
  ".github/copilot-instructions.md"
];
var MAX_PER_FILE_CHARS = 4e3;
var MAX_TOTAL_CHARS = 8e3;
function loadWorkspaceRules(roots) {
  if (!roots.length)
    return void 0;
  const rootFs = roots[0].uri.fsPath;
  const sections = [];
  let total = 0;
  for (const rel of RULES_FILES) {
    if (total >= MAX_TOTAL_CHARS)
      break;
    const abs = path.join(rootFs, rel);
    let content;
    try {
      content = fs.readFileSync(abs, "utf8").trim();
    } catch {
      continue;
    }
    if (!content)
      continue;
    let clipped = content.slice(0, Math.min(MAX_PER_FILE_CHARS, MAX_TOTAL_CHARS - total));
    if (clipped.length < content.length)
      clipped += "\n\u2026 (truncated)";
    total += clipped.length;
    sections.push(`From \`${rel}\`:
${clipped}`);
  }
  return sections.length ? sections.join("\n\n") : void 0;
}
export {
  loadWorkspaceRules
};
