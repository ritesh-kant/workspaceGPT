#!/usr/bin/env node
/**
 * DEV ONLY — seed a desktop profile from this machine's VS Code extension so
 * the Phase 0 spike can ask a grounded question without re-running Confluence
 * OAuth + a full index. A one-shot COPY; the desktop never reads the
 * extension's directory afterwards (two writers on chats/*.json is the
 * stale-history bug — challenge #11).
 *
 * Copies:
 *   - globalState `settings` (Confluence + mode/onboarding/embedding/vector-store
 *     blocks only; ADO/Jira/deployment are dropped because their credentials
 *     can't come along) and `confluence-site`
 *   - the Confluence index: <globalStorage>/confluence/{mds,embeddings}
 *
 * Never copies secrets. VS Code encrypts them with its own keychain key, and
 * the desktop has its own keychain entry anyway: sign in to remote mode again
 * inside the desktop. Live Confluence calls (get_confluence_page, auto-sync)
 * need a real Confluence connection made in the desktop; search_docs only
 * needs the index.
 *
 *   node scripts/seed-from-vscode.mjs [--data-dir <dir>] [--force]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const force = args.includes('--force');
const dataDirArg = args.includes('--data-dir') ? path.resolve(args[args.indexOf('--data-dir') + 1]) : undefined;

if (process.platform !== 'darwin') {
  console.error('seed-from-vscode only knows the macOS VS Code layout so far.');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../vscode-extensions/package.json'), 'utf8'));
const extId = `${pkg.publisher}.${pkg.name}`;
const codeGlobal = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage');
const vscdb = path.join(codeGlobal, 'state.vscdb');
const extStorage = path.join(codeGlobal, extId.toLowerCase());
const dataDir = dataDirArg ?? process.env.WGPT_DESKTOP_DATA_DIR ?? path.join(os.homedir(), 'Library/Application Support/WorkspaceGPT Desktop');

const raw = execFileSync('sqlite3', ['-readonly', vscdb, `select value from ItemTable where key = '${extId.replace(/'/g, "''")}'`], { encoding: 'utf8' });
if (!raw.trim()) {
  console.error(`No globalState for ${extId} in ${vscdb}`);
  process.exit(1);
}
const vsState = JSON.parse(raw);

const settings = structuredClone(vsState.settings);
const cfg = settings?.state?.config;
if (!cfg?.confluence?.isIndexingCompleted) {
  console.error('The VS Code extension has no completed Confluence index to copy.');
  process.exit(1);
}
for (const k of ['ado', 'jira', 'deployment']) delete cfg[k];
// A copied profile must not think a sync is mid-flight.
Object.assign(cfg.confluence, { isSyncing: false, isIndexing: false, _needsResume: false, _needsResumeIndexing: false });

fs.mkdirSync(path.join(dataDir, 'storage'), { recursive: true });
const stateFile = path.join(dataDir, 'state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
if (state.settings && !force) {
  console.error(`${stateFile} already has settings — pass --force to overwrite.`);
  process.exit(1);
}
state.settings = settings;
if (vsState['confluence-site']) state['confluence-site'] = vsState['confluence-site'];
fs.writeFileSync(stateFile, JSON.stringify(state, null, 1), { mode: 0o600 });

const src = path.join(extStorage, 'confluence');
const dest = path.join(dataDir, 'storage', 'confluence');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const count = (d) => (fs.existsSync(d) ? fs.readdirSync(d).length : 0);

console.log(`Seeded ${dataDir}
  settings: mode=${cfg.mode}, Confluence site=${cfg.confluence.siteName ?? '?'} space=${cfg.confluence.spaceKey ?? '?'}
  index:    ${count(path.join(dest, 'mds'))} pages, ${count(path.join(dest, 'embeddings'))} embedding files
Next: start the desktop and sign in to remote mode (Settings → Account). Secrets were not copied.`);
