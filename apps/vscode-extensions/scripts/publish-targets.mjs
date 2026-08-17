/**
 * Builds and (optionally) publishes one VSIX per platform/arch target instead
 * of a single universal package. A universal package has to carry
 * onnxruntime-node's native binary for every platform at once; per-target
 * packages carry only their own, which is what keeps each upload small
 * enough not to stall against the Marketplace/Open VSX APIs.
 *
 * Each target sets VSCODE_TARGET before invoking `vsce package`, which
 * spawns the `vscode:prepublish` hook (download-models + build) as a child
 * process inheriting this env - esbuild.config.js reads it to filter
 * onnxruntime-node's bin/napi-v3/<platform>/<arch> folders.
 *
 * Usage:
 *   node scripts/publish-targets.mjs [--pre-release] [--package-only]
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = join(__dirname, '..');

const { name, version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));

const TARGETS = [
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
  'darwin-x64',
  'darwin-arm64',
];

const args = process.argv.slice(2);
const preRelease = args.includes('--pre-release');
const packageOnly = args.includes('--package-only');
const preReleaseFlag = preRelease ? ['--pre-release'] : [];

const SECRETS = [process.env.OVSX_TOKEN, process.env.VSCE_PAT].filter(Boolean);

function run(command, commandArgs, extraEnv = {}) {
  const printedArgs = commandArgs.map(a => (SECRETS.includes(a) ? '***' : a));
  console.log(`\n$ ${command} ${printedArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...extraEnv },
  });
  return result.status === 0;
}

const failures = [];

for (const target of TARGETS) {
  console.log(`\n=== ${target} ===`);
  const vsixPath = join(cwd, `${name}-${target}-${version}.vsix`);

  const packaged = run(
    'npx',
    ['vsce', 'package', '--no-dependencies', '--target', target, ...preReleaseFlag],
    { VSCODE_TARGET: target }
  );
  if (!packaged || !existsSync(vsixPath)) {
    failures.push(`${target}: package`);
    continue;
  }

  if (packageOnly) {
    continue;
  }

  const publishedMarketplace = run('npx', [
    'vsce', 'publish',
    '--packagePath', vsixPath,
    '--no-dependencies',
    '--skip-duplicate',
    ...preReleaseFlag,
  ]);
  if (!publishedMarketplace) {
    failures.push(`${target}: marketplace publish`);
  }

  if (!process.env.OVSX_TOKEN) {
    console.error(`OVSX_TOKEN not set - skipping Open VSX publish for ${target}`);
    failures.push(`${target}: ovsx publish (OVSX_TOKEN not set)`);
    continue;
  }

  const publishedOvsx = run('npx', [
    'ovsx', 'publish',
    '--packagePath', vsixPath,
    '--no-dependencies',
    '--skip-duplicate',
    ...preReleaseFlag,
    '-p', process.env.OVSX_TOKEN,
  ]);
  if (!publishedOvsx) {
    failures.push(`${target}: ovsx publish`);
  }
}

console.log('\n=== Summary ===');
if (failures.length === 0) {
  console.log(`All ${TARGETS.length} targets packaged${packageOnly ? '' : ' and published'} successfully.`);
} else {
  console.log(`${failures.length} step(s) failed:`);
  failures.forEach(f => console.log(`  - ${f}`));
  console.log('\nRe-run this script - vsce/ovsx reject a version already published, so already-completed targets are safe to repeat.');
}

if (!packageOnly && failures.length === 0) {
  run('pnpm', ['run', 'create-tag']);
}

process.exit(failures.length === 0 ? 0 : 1);
