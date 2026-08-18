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
];

export async function buildUnits() {
  await esbuild.build({
    entryPoints: UNITS.map((u) => path.join(extRoot, u)),
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    sourcemap: false,
    logLevel: 'silent',
    alias: { vscode: path.join(here, 'vscode-stub.mjs') },
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
