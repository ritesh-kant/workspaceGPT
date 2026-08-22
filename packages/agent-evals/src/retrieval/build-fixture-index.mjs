/**
 * One-time (cached) embedding build for the retrieval-quality eval's fixture
 * corpus (fixtures/retrieval/corpus/*.md). Drives the REAL
 * dist/workers/common/createEmbeddingForText.js — same process real
 * Confluence/ADO syncs use — fully offline via the bundled local ONNX model
 * (@xenova/transformers + dist/models), so no network or API key is needed.
 *
 * The embedding dir is named .../confluence/embeddings so
 * createEmbeddingForText.ts's `sourceFromPath` (keyed off the PARENT
 * directory name) tags every entry CONFLUENCE, matching the fixture's mix of
 * wiki pages and ADO-style tickets (both are searched under one namespace in
 * this eval — see retrieval-eval.mjs).
 *
 * Run: node src/retrieval/build-fixture-index.mjs [--rebuild]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(pkgRoot, '../..');
const extRoot = path.join(repoRoot, 'apps/vscode-extensions');

export const CORPUS_DIR = path.join(pkgRoot, 'fixtures/retrieval/corpus');
export const EMBEDDING_DIR = path.join(pkgRoot, '.build/retrieval-fixture/confluence/embeddings');
const CREATE_EMBEDDING_PROCESS = path.join(extRoot, 'dist/workers/common/createEmbeddingForText.js');
const HASH_FILE = path.join(EMBEDDING_DIR, '.corpus-hash');

function corpusHash() {
  const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md')).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(fs.readFileSync(path.join(CORPUS_DIR, f)));
  }
  return h.digest('hex');
}

/** Builds (or reuses, if the corpus hasn't changed) the fixture embedding index. Returns the corpus hash. */
export async function buildFixtureIndex({ force = false, log = console.log } = {}) {
  if (!fs.existsSync(CREATE_EMBEDDING_PROCESS)) {
    throw new Error(
      `${path.relative(repoRoot, CREATE_EMBEDDING_PROCESS)} does not exist — build the extension's worker ` +
        `bundles first: cd apps/vscode-extensions && node esbuild.config.js`,
    );
  }

  const hash = corpusHash();
  const cached = fs.existsSync(HASH_FILE) && fs.readFileSync(HASH_FILE, 'utf8').trim() === hash;
  const indexed = fs.existsSync(path.join(EMBEDDING_DIR, 'index.json'));
  if (!force && cached && indexed) {
    log(`build-fixture-index: cache hit (${hash.slice(0, 12)}…) — skipping embed`);
    return hash;
  }

  fs.mkdirSync(EMBEDDING_DIR, { recursive: true });
  log(`build-fixture-index: embedding ${fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.md')).length} fixture docs (local ONNX)…`);

  const workerData = JSON.stringify({
    mdDirPath: CORPUS_DIR,
    embeddingDirPath: EMBEDDING_DIR,
    config: { provider: 'local' },
    resume: false,
  });

  await new Promise((resolve, reject) => {
    const child = fork(CREATE_EMBEDDING_PROCESS, [], {
      env: { ...process.env, workerData },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', (d) => process.env.VERBOSE && log(`  [embed] ${d.toString().trimEnd()}`));
    child.stderr?.on('data', (d) => log(`  [embed:stderr] ${d.toString().trimEnd()}`));
    child.on('message', (msg) => {
      if (msg?.type === 'completed') {
        child.kill();
        resolve();
      } else if (msg?.type === 'error') {
        child.kill();
        reject(new Error(msg.message));
      }
      // 'processing' messages are progress-only — ignored here.
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`createEmbeddingForText exited with code ${code}`));
    });
  });

  fs.writeFileSync(HASH_FILE, hash);
  log(`build-fixture-index: done — index at ${path.relative(pkgRoot, EMBEDDING_DIR)}`);
  return hash;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const force = process.argv.includes('--rebuild');
  buildFixtureIndex({ force }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
