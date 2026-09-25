#!/usr/bin/env node
/**
 * Cuts a desktop release: bumps the version, commits, tags desktop-vX.Y.Z and
 * pushes both. The tag starts .github/workflows/desktop-publish.yml, which
 * builds macOS + Windows, publishes the release and repoints desktop-latest.
 *
 *   pnpm release:desktop patch|minor|major|X.Y.Z [--dry-run] [--yes]
 *
 * The version lives in four files (package.json, tauri.conf.json, Cargo.toml,
 * Cargo.lock); the workflow fails if they disagree with the tag. Runs only on
 * an up-to-date main, and asks before pushing: once the tag is pushed,
 * installed apps pick the release up on their next update check.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const yes = args.includes('--yes');
const bump = args.find((a) => !a.startsWith('--'));

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

if (!bump) die('usage: pnpm release:desktop patch|minor|major|X.Y.Z [--dry-run] [--yes]');

const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const [maj, min, pat] = current.split('.').map(Number);
const next =
  bump === 'patch' ? `${maj}.${min}.${pat + 1}` :
  bump === 'minor' ? `${maj}.${min + 1}.0` :
  bump === 'major' ? `${maj + 1}.0.0` :
  bump;
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`"${bump}" is not patch, minor, major or X.Y.Z`);
const newer = next.split('.').map(Number).reduce((d, n, i) => d || n - [maj, min, pat][i], 0) > 0;
if (!newer) die(`${next} is not newer than the current ${current}`);
const tag = `desktop-v${next}`;

// Each file's version line, matched on the exact current version, so a file
// that has drifted fails here instead of shipping a mismatched build.
const FILES = [
  ['package.json', /("version":\s*")([^"]+)(")/],
  ['src-tauri/tauri.conf.json', /("version":\s*")([^"]+)(")/],
  ['src-tauri/Cargo.toml', /^(version\s*=\s*")([^"]+)(")/m],
  ['src-tauri/Cargo.lock', /(name = "workspacegpt-desktop"\nversion = ")([^"]+)(")/],
];
const edits = FILES.map(([rel, re]) => {
  const file = path.join(root, rel);
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(re);
  if (!m) die(`no version found in ${rel}`);
  if (m[2] !== current) die(`${rel} has ${m[2]}, package.json has ${current}; fix that first`);
  return { rel, file, text: text.replace(re, `$1${next}$3`) };
});

// Preflight: release from exactly what is on origin/main.
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'main') die(`on ${branch}; switch to main`);
git('fetch', '--quiet', '--tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) die('main is not the same as origin/main; pull or push first');
if (git('diff', '--cached', '--name-only')) die('there are staged changes; commit or unstage them');
// git runs in apps/desktop, so these pathspecs are relative to it.
const relPaths = edits.map((e) => e.rel);
const dirty = git('status', '--porcelain', '--', ...relPaths);
if (dirty) die(`uncommitted changes to version files; commit or revert them:\n${dirty}`);
if (git('tag', '--list', tag)) die(`tag ${tag} already exists`);

const head = git('rev-parse', '--short', 'HEAD');
console.log(`Desktop ${current} -> ${next}: commit on main (${head}), tag ${tag}, push both.`);
for (const p of relPaths) console.log(`  apps/desktop/${p}`);
if (dryRun) {
  console.log('--dry-run: nothing changed.');
  process.exit(0);
}
if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Publish ${tag} to every user? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) die('cancelled; nothing changed');
}

for (const e of edits) fs.writeFileSync(e.file, e.text);
git('commit', '--quiet', '-m', `desktop: ${next}`, '--', ...relPaths);
git('tag', '-a', tag, '-m', `WorkspaceGPT Desktop ${next}`);
try {
  // Atomic: either main and the tag both land, or neither does.
  git('push', '--atomic', 'origin', 'main', `refs/tags/${tag}`);
} catch (err) {
  die(`push failed (${err.message.split('\n')[0]}). Undo locally with:\n  git tag -d ${tag} && git reset --keep HEAD~1`);
}

const repo = git('remote', 'get-url', 'origin').replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
console.log(`Pushed ${tag}. The build runs in GitHub Actions (~16 min):`);
console.log(`  https://github.com/${repo}/actions/workflows/desktop-publish.yml`);
console.log(`  https://github.com/${repo}/releases/tag/${tag} (once it finishes)`);
