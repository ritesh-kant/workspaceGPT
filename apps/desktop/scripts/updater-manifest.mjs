#!/usr/bin/env node
/**
 * Writes the `latest.json` the desktop updater reads (src-tauri/src/updater.rs).
 *
 *   node scripts/updater-manifest.mjs --version 0.0.2 --base-url <url> [--notes "…"] [--out latest.json] \
 *     darwin-aarch64=path/to/WorkspaceGPT.app.tar.gz [windows-x86_64=path/to/…-setup.exe …]
 *
 * Each bundle needs its `.sig` next to it. `tauri build` writes one when
 * TAURI_SIGNING_PRIVATE_KEY is set and `bundle.createUpdaterArtifacts` is on.
 * A platform's `url` is `<base-url>/<bundle file name>`, so upload the bundles
 * where that URL points: the versioned GitHub release in CI, a local
 * server in the update test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const opts = { notes: '', out: 'latest.json' };
const platforms = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--version') opts.version = args[++i];
  else if (a === '--base-url') opts.baseUrl = args[++i].replace(/\/+$/, '');
  else if (a === '--notes') opts.notes = args[++i];
  else if (a === '--out') opts.out = args[++i];
  else if (a.includes('=')) {
    const [platform, file] = a.split(/=(.*)/s);
    const sigFile = `${file}.sig`;
    if (!fs.existsSync(file) || !fs.existsSync(sigFile)) {
      console.error(`${platform}: ${file} or its .sig is missing`);
      process.exit(1);
    }
    platforms[platform] = { file, signature: fs.readFileSync(sigFile, 'utf8').trim() };
  } else {
    console.error(`unknown argument ${a}`);
    process.exit(1);
  }
}
if (!opts.version || !opts.baseUrl || !Object.keys(platforms).length) {
  console.error('usage: updater-manifest.mjs --version X.Y.Z --base-url URL [--notes TEXT] [--out FILE] <platform>=<bundle> …');
  process.exit(1);
}

const manifest = {
  version: opts.version,
  notes: opts.notes,
  pub_date: new Date().toISOString(),
  platforms: Object.fromEntries(
    Object.entries(platforms).map(([p, { file, signature }]) => [
      p,
      { signature, url: `${opts.baseUrl}/${encodeURIComponent(path.basename(file))}` },
    ])
  ),
};
fs.writeFileSync(opts.out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${opts.out}: v${opts.version} for ${Object.keys(platforms).join(', ')}`);
