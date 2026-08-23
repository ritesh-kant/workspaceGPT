/**
 * Compiles the extension's agent service modules to importable ESM for
 * headless tests, aliasing `vscode` to ./vscode-stub.mjs. Reuses the
 * extension's own esbuild install — no new dependency.
 */
import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const extRoot = path.join(repoRoot, 'apps/vscode-extensions');
const outDir = path.join(here, '../../.build');

const require = createRequire(path.join(extRoot, 'package.json'));
const esbuild = require('esbuild');

const UNITS = [
  'src/services/agent/agentWriteTools.ts',
  'src/services/agent/commandTools.ts',
  'src/services/agent/checkpointService.ts',
  'src/services/agent/rulesFiles.ts',
  'src/services/codebase/codebaseTools.ts',
  'src/utils/reranker.ts',
  'src/utils/queryPlanner.ts',
  'src/utils/queryClassifier.ts',
  'constants.ts', // pure data — MODEL_PROVIDERS base URLs for the judge
];

// codebaseTools.ts dynamically `import('@vscode/ripgrep')`s to find the `rg`
// binary. That module resolves its platform-specific binary package via
// `require.resolve` relative to ITS OWN file location (@vscode/ripgrep's own
// `import.meta.url`) — bundling it would rewrite that location to somewhere
// inside .build/ where the platform package doesn't exist, breaking
// resolution silently (searchCodebase would then fall back to the JS
// scanner every time, invisibly). Keep it external, pointed at its real
// on-disk path, so the runtime `import()` in the compiled unit still finds
// the real installed package.
const ripgrepExternalPlugin = {
  name: 'ripgrep-external',
  setup(build) {
    build.onResolve({ filter: /^@vscode\/ripgrep$/ }, () => ({
      path: require.resolve('@vscode/ripgrep'),
      external: true,
    }));
  },
};

export async function buildUnits() {
  // Entry points as a name->path map (rather than a bare array) keeps output
  // flat in outDir regardless of source nesting — with a plain array, adding
  // codebaseTools.ts (under services/codebase/, a sibling of services/agent/)
  // shifts esbuild's inferred common ancestor up a level and nests the
  // output into agent/ and codebase/ subdirectories, breaking every existing
  // `path.join(outDir, '<name>.mjs')` import in the harnesses.
  const entryPoints = Object.fromEntries(
    UNITS.map((u) => [path.basename(u, '.ts'), path.join(extRoot, u)]),
  );
  await esbuild.build({
    entryPoints,
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    sourcemap: false,
    logLevel: 'silent',
    alias: { vscode: path.join(here, 'vscode-stub.mjs') },
    plugins: [ripgrepExternalPlugin],
  });
  return outDir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildUnits().then(
    (d) => console.log(`built → ${d}`),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
