#!/usr/bin/env node
/**
 * Downloads the Node binary the desktop app ships (Phase 3), for one target,
 * and verifies it against nodejs.org's SHASUMS256.txt before using it.
 *
 *   node scripts/fetch-node.mjs [--target darwin-arm64]   → prints the binary's path
 *
 * Cached under apps/desktop/.cache/node/<version>-<target>/, so a rebuild
 * doesn't download again. The version is pinned here, not taken from
 * whatever node runs the build: the app must behave the same on every
 * machine that installs it.
 */
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Active LTS; the sidecar was developed and tested on 24.x. typescript-language-server needs >= 20. */
export const NODE_VERSION = 'v24.21.0';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** target (the extension's VSCODE_TARGET names) → nodejs.org archive name and the binary inside it. */
const ARCHIVES = {
  'darwin-arm64': { file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, bin: `node-${NODE_VERSION}-darwin-arm64/bin/node` },
  'darwin-x64': { file: `node-${NODE_VERSION}-darwin-x64.tar.gz`, bin: `node-${NODE_VERSION}-darwin-x64/bin/node` },
  'linux-x64': { file: `node-${NODE_VERSION}-linux-x64.tar.xz`, bin: `node-${NODE_VERSION}-linux-x64/bin/node` },
  'linux-arm64': { file: `node-${NODE_VERSION}-linux-arm64.tar.xz`, bin: `node-${NODE_VERSION}-linux-arm64/bin/node` },
  'win32-x64': { file: `node-${NODE_VERSION}-win-x64.zip`, bin: `node-${NODE_VERSION}-win-x64/node.exe` },
  'win32-arm64': { file: `node-${NODE_VERSION}-win-arm64.zip`, bin: `node-${NODE_VERSION}-win-arm64/node.exe` },
};

export function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Returns the absolute path of the verified node binary for `target`. */
export async function fetchNode(target = hostTarget()) {
  const archive = ARCHIVES[target];
  if (!archive) throw new Error(`no Node build for target "${target}" (known: ${Object.keys(ARCHIVES).join(', ')})`);
  const dir = path.join(root, '.cache', 'node', `${NODE_VERSION}-${target}`);
  const binary = path.join(dir, path.basename(archive.bin));
  if (fs.existsSync(binary)) return binary;

  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === archive.file)?.[0];
  if (!expected) throw new Error(`${archive.file} is not listed in ${base}/SHASUMS256.txt`);

  console.error(`[fetch-node] downloading ${base}/${archive.file}`);
  const data = await download(`${base}/${archive.file}`);
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`${archive.file}: sha256 ${actual} does not match SHASUMS256.txt (${expected})`);

  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, 'extract-'));
  const archivePath = path.join(tmp, archive.file);
  fs.writeFileSync(archivePath, data);
  // bsdtar (macOS, Windows 10+) reads .zip and .tar.*; GNU tar (Linux CI) reads .tar.xz.
  execFileSync('tar', ['-xf', archivePath, '-C', tmp, archive.bin], { stdio: 'inherit' });
  fs.renameSync(path.join(tmp, archive.bin), binary);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
  console.error(`[fetch-node] ${binary} (sha256 verified)`);
  return binary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--target');
  console.log(await fetchNode(i > 0 ? process.argv[i + 1] : hostTarget()));
}
