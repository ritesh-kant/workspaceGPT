/**
 * The 10 Phase-0.1 eval tasks — real edits on snapshotted files from this repo
 * (fixtures/). Each task: { id, files: [fixture names], instruction, checks }.
 * A check is { desc, fn(files) -> boolean } run against the post-apply file map.
 *
 * Paths given to the model are the repo-relative originals so instructions read
 * naturally; the harness maps fixtures onto those paths.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** fixture file → the repo-relative path the model sees */
export const PATHS = {
  'constants.ts': 'apps/vscode-extensions/constants.ts',
  'getLlmSettings.ts': 'apps/vscode-extensions/src/utils/getLlmSettings.ts',
  'codebaseTools.ts': 'apps/vscode-extensions/src/services/codebase/codebaseTools.ts',
  'RemoteEngineSettings.tsx': 'apps/vscode-extensions/webview/src/components/settings/RemoteEngineSettings.tsx',
  'App.css': 'apps/vscode-extensions/webview/src/App.css',
  'extension-package.json': 'apps/vscode-extensions/package.json',
};

export function loadFiles(names) {
  const map = {};
  for (const n of names) map[PATHS[n]] = fixture(n);
  return map;
}

const P = PATHS;
const count = (s, needle) => s.split(needle).length - 1;

export const tasks = [
  {
    id: 'add-task-kind',
    files: ['constants.ts'],
    instruction: `In ${P['constants.ts']}, add a new inference task kind 'summarize' to the LlmTask type union, and add a corresponding entry to REMOTE_TASK_MODELS routing it to provider 'Gemini', model 'models/gemini-2.5-flash-lite'.`,
    checks: [
      { desc: 'LlmTask union has summarize', fn: (f) => /LlmTask\s*=[^;]*'summarize'/s.test(f[P['constants.ts']]) },
      { desc: 'routing entry added', fn: (f) => /summarize:\s*\{\s*provider:\s*'Gemini',\s*model:\s*'models\/gemini-2\.5-flash-lite'/.test(f[P['constants.ts']]) },
    ],
  },
  {
    id: 'rename-fn',
    files: ['getLlmSettings.ts'],
    instruction: `In ${P['getLlmSettings.ts']}, rename the function remoteKeysForProvider to resolveRemoteProviderKeys everywhere it appears (definition, call site, and any doc-comment references).`,
    checks: [
      { desc: 'old name gone', fn: (f) => !f[P['getLlmSettings.ts']].includes('remoteKeysForProvider') },
      { desc: 'new name ≥2×', fn: (f) => count(f[P['getLlmSettings.ts']], 'resolveRemoteProviderKeys') >= 2 },
    ],
  },
  {
    id: 'large-file-edit',
    files: ['codebaseTools.ts'],
    instruction: `In ${P['codebaseTools.ts']}, add an optional field to the SearchCodebaseArgs interface: maxResults?: number, with the doc comment "/** Cap on returned matches (default 50). */" on the line above it. Change nothing else.`,
    checks: [
      { desc: 'field added', fn: (f) => /maxResults\?\s*:\s*number/.test(f[P['codebaseTools.ts']]) },
      { desc: 'doc comment present', fn: (f) => f[P['codebaseTools.ts']].includes('Cap on returned matches (default 50).') },
      { desc: 'file integrity (no truncation)', fn: (f) => {
          const lines = f[P['codebaseTools.ts']].split('\n').length;
          return lines >= 815 && lines <= 830 && f[P['codebaseTools.ts']].includes('buildRepoOrientation');
        } },
    ],
  },
  {
    id: 'tsx-add-button',
    files: ['RemoteEngineSettings.tsx'],
    instruction: `In ${P['RemoteEngineSettings.tsx']}, add a "Clear all" button immediately after the existing "+ Add API key" button. It should call a new function clearApiKeys that resets the key list to a single empty string via setApiKeys(['']). Define clearApiKeys next to the other key-list helpers. Give the button className 'add-key-button' and type 'button' like its sibling.`,
    checks: [
      { desc: 'handler defined', fn: (f) => /clearApiKeys\s*=\s*\(\)\s*=>\s*setApiKeys\(\[''\]\)/.test(f[P['RemoteEngineSettings.tsx']]) },
      { desc: 'button wired', fn: (f) => /Clear all/.test(f[P['RemoteEngineSettings.tsx']]) && /onClick=\{clearApiKeys\}/.test(f[P['RemoteEngineSettings.tsx']]) },
    ],
  },
  {
    id: 'create-file',
    files: [],
    instruction: `Create a new file apps/vscode-extensions/src/utils/keyMask.ts containing a single exported function: maskKey(key: string): string. It returns the first 4 characters + '…' + the last 2 characters; if the key is 8 characters or shorter, return '••••' instead. Include a brief doc comment.`,
    checks: [
      { desc: 'file created with export', fn: (f) => /export function maskKey\s*\(\s*key:\s*string\s*\)\s*:\s*string/.test(f['apps/vscode-extensions/src/utils/keyMask.ts'] ?? '') },
      { desc: 'short-key branch present', fn: (f) => (f['apps/vscode-extensions/src/utils/keyMask.ts'] ?? '').includes('••••') },
    ],
  },
  {
    id: 'delete-block',
    files: ['RemoteEngineSettings.tsx'],
    instruction: `In ${P['RemoteEngineSettings.tsx']}, remove the JSX block that renders the Qdrant test result (the \`{testResult && (...)}\` expression containing the 'status-message' div). Keep the "Test connection" button and all state/handlers.`,
    checks: [
      { desc: 'status block gone', fn: (f) => !f[P['RemoteEngineSettings.tsx']].includes('status-message') },
      { desc: 'button kept', fn: (f) => f[P['RemoteEngineSettings.tsx']].includes('Test connection') },
      { desc: 'state kept', fn: (f) => f[P['RemoteEngineSettings.tsx']].includes('setTestResult') },
    ],
  },
  {
    id: 'css-append',
    files: ['App.css'],
    instruction: `In ${P['App.css']}, add a new rule at the very end of the file: .agent-panel with display: flex, flex-direction: column, and gap: 8px.`,
    checks: [
      { desc: 'rule appended', fn: (f) => /\.agent-panel\s*\{[^}]*display:\s*flex/s.test(f[P['App.css']]) },
      { desc: 'existing css intact', fn: (f) => f[P['App.css']].split('\n').length >= 1035 },
    ],
  },
  {
    id: 'json-edit',
    files: ['extension-package.json'],
    instruction: `In ${P['extension-package.json']}, add a new npm script "eval" with the value "node ../../packages/agent-evals/src/run.mjs" to the existing scripts section.`,
    checks: [
      { desc: 'valid JSON', fn: (f) => { try { JSON.parse(f[P['extension-package.json']]); return true; } catch { return false; } } },
      { desc: 'script added', fn: (f) => { try { return JSON.parse(f[P['extension-package.json']]).scripts?.eval === 'node ../../packages/agent-evals/src/run.mjs'; } catch { return false; } } },
    ],
  },
  {
    id: 'ambiguous-target',
    files: ['getLlmSettings.ts'],
    instruction: `In ${P['getLlmSettings.ts']}, the expression \`apiKey: apiKeys[0] || undefined\` appears twice — once in the remote-mode return and once in the local-mode return at the bottom. In the LOCAL-mode return only, change it to \`apiKey: apiKeys.at(0)\`. Leave the remote-mode branch untouched.`,
    checks: [
      { desc: 'local branch changed', fn: (f) => count(f[P['getLlmSettings.ts']], 'apiKeys.at(0)') === 1 },
      { desc: 'remote branch untouched', fn: (f) => count(f[P['getLlmSettings.ts']], 'apiKeys[0] || undefined') === 1 },
    ],
  },
  {
    id: 'multi-file-rename',
    files: ['constants.ts', 'getLlmSettings.ts'],
    instruction: `Rename the exported type LlmTask to InferenceTask across both files: its definition and every usage in ${P['constants.ts']} (including the REMOTE_TASK_MODELS Record type and any doc comments), and the import plus every usage in ${P['getLlmSettings.ts']}.`,
    checks: [
      { desc: 'constants: old name gone', fn: (f) => !/\bLlmTask\b/.test(f[P['constants.ts']]) },
      { desc: 'constants: record retyped', fn: (f) => /REMOTE_TASK_MODELS:\s*Record<InferenceTask/.test(f[P['constants.ts']]) },
      { desc: 'settings: old name gone', fn: (f) => !/\bLlmTask\b/.test(f[P['getLlmSettings.ts']]) },
      { desc: 'settings: new name used', fn: (f) => count(f[P['getLlmSettings.ts']], 'InferenceTask') >= 2 },
    ],
  },
];
