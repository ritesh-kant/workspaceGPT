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

const { name, version, publisher } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
const extensionId = `${publisher}.${name}`;

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

// vsce's --skip-duplicate matches on version alone and ignores --target, so
// after the first target uploads, every later target is falsely skipped as a
// "duplicate". Instead we ask each registry which targets already exist for
// this version and skip those ourselves, publishing the rest without the flag.
async function fetchPublishedTargets(url, options, extractVersions) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) return null;
    return extractVersions(await res.json());
  } catch {
    return null;
  }
}

async function marketplaceTargets(extensionId) {
  const versions = await fetchPublishedTargets(
    'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json;api-version=7.1-preview.1',
      },
      body: JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: extensionId }] }],
        flags: 51,
      }),
    },
    data => data?.results?.[0]?.extensions?.[0]?.versions
  );
  if (!versions) return null;
  return new Set(
    versions.filter(v => v.version === version && v.targetPlatform).map(v => v.targetPlatform)
  );
}

async function ovsxTargets(extensionId) {
  const [publisher, extName] = extensionId.split('.');
  const data = await fetchPublishedTargets(
    `https://open-vsx.org/api/${publisher}/${extName}/${version}`,
    {},
    d => d
  );
  if (!data) return new Set(); // 404 = version not published for any target yet
  const downloads = data.downloads ?? {};
  return new Set(Object.keys(downloads).filter(t => t !== 'universal'));
}

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

let publishedOnMarketplace = new Set();
let publishedOnOvsx = new Set();
if (!packageOnly) {
  const mp = await marketplaceTargets(extensionId);
  if (mp === null) {
    console.error('Could not query Marketplace for existing targets - assuming none published.');
  } else {
    publishedOnMarketplace = mp;
  }
  publishedOnOvsx = await ovsxTargets(extensionId);
  console.log(`\nv${version} already on Marketplace for: ${[...publishedOnMarketplace].join(', ') || '(none)'}`);
  console.log(`v${version} already on Open VSX for: ${[...publishedOnOvsx].join(', ') || '(none)'}`);
}

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

  if (publishedOnMarketplace.has(target)) {
    console.log(`Marketplace already has v${version} for ${target} - skipping.`);
  } else {
    const publishedMarketplace = run('npx', [
      'vsce', 'publish',
      '--packagePath', vsixPath,
      '--no-dependencies',
      ...preReleaseFlag,
    ]);
    if (!publishedMarketplace) {
      failures.push(`${target}: marketplace publish`);
    }
  }

  if (!process.env.OVSX_TOKEN) {
    console.error(`OVSX_TOKEN not set - skipping Open VSX publish for ${target}`);
    failures.push(`${target}: ovsx publish (OVSX_TOKEN not set)`);
    continue;
  }

  if (publishedOnOvsx.has(target)) {
    console.log(`Open VSX already has v${version} for ${target} - skipping.`);
  } else {
    const publishedOvsx = run('npx', [
      'ovsx', 'publish',
      '--packagePath', vsixPath,
      '--no-dependencies',
      ...preReleaseFlag,
      '-p', process.env.OVSX_TOKEN,
    ]);
    if (!publishedOvsx) {
      failures.push(`${target}: ovsx publish`);
    }
  }
}

console.log('\n=== Summary ===');
if (failures.length === 0) {
  console.log(`All ${TARGETS.length} targets packaged${packageOnly ? '' : ' and published'} successfully.`);
} else {
  console.log(`${failures.length} step(s) failed:`);
  failures.forEach(f => console.log(`  - ${f}`));
  console.log('\nRe-run this script - already-published targets are detected via the registry APIs and skipped, so completed targets are safe to repeat.');
}

if (!packageOnly && failures.length === 0) {
  const tagExists = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/workspaceGPT-v${version}`], { cwd }).status === 0;
  if (tagExists) {
    console.log(`Tag workspaceGPT-v${version} already exists - skipping create-tag.`);
  } else {
    run('pnpm', ['run', 'create-tag']);
  }
}

process.exit(failures.length === 0 ? 0 : 1);
