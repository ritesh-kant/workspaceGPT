/**
 * Uploads the packaged .zip to the Chrome Web Store and (optionally) publishes
 * it, using the official chrome-webstore-upload-cli over npx — no extra
 * dependency in package.json.
 *
 * Requires these env vars (create them once, store as CI secrets):
 *   CWS_EXTENSION_ID    the item id from the developer dashboard URL
 *   CWS_CLIENT_ID       Google OAuth client id
 *   CWS_CLIENT_SECRET   Google OAuth client secret
 *   CWS_REFRESH_TOKEN   OAuth refresh token for the publisher account
 * Setup guide: https://github.com/fregante/chrome-webstore-upload-keys
 *
 * Usage:
 *   node scripts/publish.mjs            # upload as draft only
 *   node scripts/publish.mjs --publish  # upload AND submit for review
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const zip = resolve(root, 'release', `workspacegpt-chrome-${version}.zip`);

const required = ['CWS_EXTENSION_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`✗ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}
if (!existsSync(zip)) {
  console.error(`✗ ${zip} not found. Run \`npm run package\` first.`);
  process.exit(1);
}

const publish = process.argv.includes('--publish');
const args = [
  'chrome-webstore-upload-cli@3',
  'upload',
  '--source', zip,
  '--extension-id', process.env.CWS_EXTENSION_ID,
  '--client-id', process.env.CWS_CLIENT_ID,
  '--client-secret', process.env.CWS_CLIENT_SECRET,
  '--refresh-token', process.env.CWS_REFRESH_TOKEN,
];
if (publish) args.splice(1, 1, 'publish'); // `publish` subcommand uploads + submits

console.log(`${publish ? 'Publishing' : 'Uploading draft of'} v${version}…`);
execFileSync('npx', args, { stdio: 'inherit' });
