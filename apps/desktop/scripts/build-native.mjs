#!/usr/bin/env node
/**
 * Compiles the desktop's native helpers (macOS only) into dist/bin/.
 *
 *   node scripts/build-native.mjs [--target darwin-arm64] [--require]
 *
 * Today that is wgpt-dictate (native/wgpt-dictate.swift), the dictation helper
 * the sidecar starts (sidecar/host/dictation.ts), and wgpt-calls
 * (native/wgpt-calls.swift), the call-detection helper for call notes
 * (sidecar/host/callDetection.ts), and wgpt-notes (native/wgpt-notes.swift),
 * which records and transcribes a call (sidecar/host/callRecorder.ts) with
 * whisper.cpp: dist/bin/libwhisper.dylib beside it, from the pinned release
 * below (downloaded once into .cache/, checked by SHA-256). Without them the composer shows no mic
 * button and call notes reports itself unavailable, so a dev build on a machine
 * without the Swift toolchain just skips them; --require (the release stage)
 * makes that an error.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTarget } from './fetch-node.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const target = argOf('target') ?? hostTarget();
const required = process.argv.includes('--require');
const [platform, arch] = target.split('-');

const skip = (why) => {
  if (required) throw new Error(`cannot build the native helpers: ${why}`);
  console.log(`[native] skipped: ${why}`);
  process.exit(0);
};
if (platform !== 'darwin') skip(`nothing to build for ${target}`);
if (process.platform !== 'darwin') skip('macOS helpers are built on macOS');

const out = path.join(root, 'dist/bin');
fs.mkdirSync(out, { recursive: true });

// whisper.cpp's prebuilt Apple framework (universal, Metal source embedded), for wgpt-notes.
const WHISPER = {
  version: 'v1.9.2',
  asset: 'whisper-v1.9.2-xcframework.zip',
  sha256: 'af74fed13ea7f2d5ca2a39d9f58ec177713fafd7cab63aef4e27b79f3ceca80b',
};
/** The macOS slice's directory (holding whisper.framework), downloaded and unpacked once. */
async function whisperFrameworkDir() {
  const cache = path.join(root, '.cache', `whisper-${WHISPER.version}`);
  const dir = path.join(cache, 'build-apple/whisper.xcframework/macos-arm64_x86_64');
  if (fs.existsSync(path.join(dir, 'whisper.framework'))) return dir;
  fs.mkdirSync(cache, { recursive: true });
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER.version}/${WHISPER.asset}`;
  console.log(`[native] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`whisper.cpp download failed: HTTP ${res.status}`);
  const zip = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(zip).digest('hex');
  if (got !== WHISPER.sha256) throw new Error(`whisper.cpp ${WHISPER.asset}: SHA-256 ${got}, expected ${WHISPER.sha256}`);
  const zipPath = path.join(cache, WHISPER.asset);
  fs.writeFileSync(zipPath, zip);
  execFileSync('ditto', ['-x', '-k', zipPath, cache]);
  fs.rmSync(zipPath);
  return dir;
}

const cpu = arch === 'arm64' ? 'arm64' : 'x86_64';
const swiftc = (helper, triple, extra = []) => {
  const r = spawnSync('swiftc', ['-O', '-swift-version', '5', '-target', triple, `native/${helper}.swift`, '-o', path.join(out, helper), ...extra], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.error?.code === 'ENOENT') skip('swiftc is not installed (xcode-select --install)');
  if (r.status !== 0) throw new Error(`swiftc failed building ${helper}`);
  console.log(`[native] dist/bin/${helper} (${triple})`);
};

// macOS 12 is the app's floor (tauri.conf.json); the helper checks for newer APIs at run time.
for (const helper of ['wgpt-dictate', 'wgpt-calls']) swiftc(helper, `${cpu}-apple-macos12.0`);

// wgpt-notes links whisper.cpp, which needs macOS 13.3 (the recorder is offered from macOS 14,
// where the call's audio can be tapped). The framework is flattened to one dylib beside the
// helper: a nested framework would complicate signing the app.
const fwDir = await whisperFrameworkDir();
swiftc('wgpt-notes', `${cpu}-apple-macos13.3`, ['-F', fwDir, '-framework', 'whisper']);
const dylib = path.join(out, 'libwhisper.dylib');
fs.copyFileSync(path.join(fwDir, 'whisper.framework/Versions/A/whisper'), dylib);
fs.chmodSync(dylib, 0o755);
execFileSync('install_name_tool', ['-id', '@executable_path/libwhisper.dylib', dylib]);
execFileSync('install_name_tool', ['-change', '@rpath/whisper.framework/Versions/Current/whisper', '@executable_path/libwhisper.dylib', path.join(out, 'wgpt-notes')]);
// install_name_tool breaks the signatures; Apple Silicon refuses to run unsigned code.
for (const f of [dylib, path.join(out, 'wgpt-notes')]) execFileSync('codesign', ['--force', '--sign', '-', f]);
console.log(`[native] dist/bin/libwhisper.dylib (whisper.cpp ${WHISPER.version})`);
