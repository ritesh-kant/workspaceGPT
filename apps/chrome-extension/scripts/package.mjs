/**
 * Zips the production build into a Chrome Web Store-ready package.
 *
 * The store requires a .zip whose ROOT contains manifest.json (no wrapping
 * folder), so we zip the *contents* of dist/ rather than dist/ itself. Run
 * `npm run build` first (the `package` npm script does this for you).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const releaseDir = resolve(root, 'release');

if (!existsSync(resolve(dist, 'manifest.json'))) {
  console.error('✗ dist/manifest.json not found. Run `npm run build` first.');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const out = resolve(releaseDir, `workspacegpt-chrome-${version}.zip`);

mkdirSync(releaseDir, { recursive: true });
rmSync(out, { force: true });

// -r recurse, -X strip extra file attrs, -x exclude dotfiles. cwd=dist so paths
// are relative to the build root (manifest.json lands at the zip root).
execFileSync('zip', ['-r', '-X', out, '.', '-x', '.*'], { cwd: dist, stdio: 'inherit' });

console.log(`\n✓ Packaged ${out}`);
