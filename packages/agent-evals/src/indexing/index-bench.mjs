/**
 * Indexing-throughput benchmark for the codebase embedding pipeline — drives
 * the REAL dist/workers/codebase/codebaseWorker.js (file collection,
 * worker_threads) and dist/workers/codebase/codebaseEmbeddingProcess.js
 * (embedding, forked child) over a pinned fixture corpus, copied to a scratch
 * dir each run so results are comparable and the fixture is never mutated.
 *
 * Measures files/min, wall clock, and peak RSS for each stage — the numbers
 * behind "how long does a codebase sync take" and "does it scale linearly".
 *
 * Run: node src/indexing/index-bench.mjs [--corpus <dir>] [--multiply N] [--stage collect|embed|all] [--docs]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Worker } from 'worker_threads';
import { fork, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const pexecFile = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '../..');
const repoRoot = path.resolve(pkgRoot, '../..');
const extRoot = path.join(repoRoot, 'apps/vscode-extensions');
const COLLECT_WORKER = path.join(extRoot, 'dist/workers/codebase/codebaseWorker.js');
const EMBED_PROCESS = path.join(extRoot, 'dist/workers/codebase/codebaseEmbeddingProcess.js');
const DOCS_EMBED_PROCESS = path.join(extRoot, 'dist/workers/common/createEmbeddingForText.js');
const DEFAULT_CORPUS = path.join(pkgRoot, 'fixtures/codebase-corpus');
const DOCS_CORPUS = path.join(pkgRoot, 'fixtures/retrieval/corpus');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const CORPUS_DIR = path.resolve(argOf('corpus', DEFAULT_CORPUS));
const MULTIPLY = Math.max(1, parseInt(argOf('multiply', '1'), 10) || 1);
const STAGE = argOf('stage', 'all'); // collect | embed | all
const WITH_DOCS = argv.includes('--docs');

for (const [label, p] of [['collect worker', COLLECT_WORKER], ['embed process', EMBED_PROCESS]]) {
  if (!fs.existsSync(p)) {
    console.error(`❌ ${label} not found at ${path.relative(repoRoot, p)} — build first: cd apps/vscode-extensions && node esbuild.config.js`);
    process.exit(1);
  }
}

const log = (s) => console.log(s);

/**
 * A syntax error inside an ESM worker_threads entry file crashes the whole
 * Node process before the Worker's own 'error' event fires — a try/catch
 * around `new Worker(...)` cannot recover from it. Preflight with a plain
 * `node --check` so a broken bundle degrades this ONE stage instead of
 * taking the whole benchmark run down with it.
 */
async function workerBundleLoads(p) {
  try {
    await pexecFile(process.execPath, ['--check', p]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).split('\n').slice(0, 3).join(' ') };
  }
}

// ── corpus prep: copy (and optionally multiply) into a scratch dir ────────

function walkFiles(dir, base = dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, base, acc);
    else acc.push(path.relative(base, abs));
  }
  return acc;
}

function corpusId(dir) {
  const files = walkFiles(dir).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, f)));
  }
  return `${path.basename(dir)}@${h.digest('hex').slice(0, 12)}`;
}

function prepareScratchCorpus(srcDir, multiply) {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-index-bench-'));
  const repoDir = path.join(scratchRoot, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });

  const files = walkFiles(srcDir);
  for (const rel of files) {
    const srcAbs = path.join(srcDir, rel);
    const content = fs.readFileSync(srcAbs);
    const { dir, name, ext } = path.parse(rel);
    for (let n = 1; n <= multiply; n++) {
      // Deterministic, collision-free basenames — codebaseEmbeddingProcess
      // keys its output file on basename ALONE (see saveEmbedding), so a
      // basename collision across replicas would silently overwrite one
      // replica's embedding with another's instead of producing N outputs.
      const suffix = n === 1 ? '' : `__${n}`;
      const destRel = path.join(dir, `${name}${suffix}${ext}`);
      const destAbs = path.join(repoDir, destRel);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.writeFileSync(destAbs, content);
    }
  }
  return { scratchRoot, repoDir, fileCount: files.length * multiply };
}

// ── stage 1: file collection (codebaseWorker.js, worker_threads) ──────────

async function runCollectStage(repoDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  let filesWritten = 0;

  await new Promise((resolve, reject) => {
    const worker = new Worker(COLLECT_WORKER, {
      workerData: {
        repoPath: repoDir,
        // A bare '**/*' also glob-matches directory entries, which
        // codebaseWorker.ts's own getFiles()/readFileData() doesn't filter
        // out — readFile() on a directory throws EISDIR. Use an
        // extension-scoped pattern (what a real repo config would set)
        // instead of trying to work around that in this benchmark.
        includePatterns: '**/*.{ts,js,tsx,jsx,md,json}',
        excludePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**'],
        maxFileSizeKb: 500,
        resume: false,
      },
    });
    worker.on('message', (msg) => {
      if (msg.type === 'processed' && msg.file) {
        // Mirror codebaseService.saveProcessedFile: one JSON per file, named
        // from its path relative to the repo root (slashes -> underscores)
        // so codebaseEmbeddingProcess.js's flat-directory reader picks it up
        // exactly like a real sync would.
        const rel = path.relative(repoDir, msg.file.filePath).replace(/[\\/]/g, '_');
        fs.writeFileSync(path.join(outDir, `${rel}.json`), JSON.stringify(msg.file));
        filesWritten++;
      } else if (msg.type === 'completed') {
        worker.terminate();
        resolve();
      } else if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    });
    worker.on('error', reject);
  });

  return { wallMs: Date.now() - started, filesWritten };
}

/**
 * Fallback for when the real collect worker's bundle won't even load (see
 * workerBundleLoads above): reproduces the same `{filename, text, filePath}`
 * JSON-per-file output by walking the scratch repo directly, so the embed
 * stage still has real input to benchmark. This is NOT a substitute
 * measurement for stage 1 — it's plain synchronous fs, not the real
 * glob-based worker — so its timing is never recorded as a `collect` result.
 */
function collectFilesDirectly(repoDir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  let filesWritten = 0;
  for (const rel of walkFiles(repoDir)) {
    const filePath = path.join(repoDir, rel);
    const text = fs.readFileSync(filePath, 'utf8');
    const outRel = rel.replace(/[\\/]/g, '_');
    fs.writeFileSync(path.join(outDir, `${outRel}.json`), JSON.stringify({ filename: path.basename(rel), text, filePath }));
    filesWritten++;
  }
  return filesWritten;
}

// ── peak-RSS sampler (polls `ps`, portable on darwin/linux) ────────────────

function samplePeakRss(pid, intervalMs = 200) {
  let peakKb = 0;
  const sample = async () => {
    try {
      const { stdout } = await pexecFile('ps', ['-o', 'rss=', '-p', String(pid)]);
      const kb = parseInt(stdout.trim(), 10);
      if (Number.isFinite(kb)) peakKb = Math.max(peakKb, kb);
    } catch {
      // process may have exited between the tick and the ps call — ignore.
    }
  };
  sample(); // fire immediately — a fast (<intervalMs) run would otherwise report 0
  const timer = setInterval(sample, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return peakKb / 1024; // MB
    },
  };
}

// ── stage 2: embedding (codebaseEmbeddingProcess.js, forked child) ────────

async function runEmbedStage(codebaseDirPath, embeddingDirPath, inputCount) {
  fs.mkdirSync(embeddingDirPath, { recursive: true });
  const child = fork(EMBED_PROCESS, [], {
    execArgv: ['--max-old-space-size=8192'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const rss = samplePeakRss(child.pid);
  const started = Date.now();
  let modelInitMs = null;
  let firstProcessingAt = null;
  let lastProcessingAt = null;
  let lastProcessedCount = 0;

  child.stdout?.on('data', (d) => {
    const text = d.toString();
    if (process.env.VERBOSE) log(`  [embed] ${text.trimEnd()}`);
    if (modelInitMs === null && text.includes('Model initialization complete')) {
      modelInitMs = Date.now() - started;
    }
  });
  child.stderr?.on('data', (d) => process.env.VERBOSE && log(`  [embed:stderr] ${d.toString().trimEnd()}`));

  await new Promise((resolve, reject) => {
    child.on('message', (msg) => {
      if (msg?.type === 'processing') {
        const now = Date.now();
        if (firstProcessingAt === null) firstProcessingAt = now;
        lastProcessingAt = now;
        // "Processed N of M files" progress fires every 10 files (see
        // processFiles in codebaseEmbeddingProcess.ts) — recover N from the
        // percentage since the raw count isn't in the message.
        lastProcessedCount = Math.round((msg.progress / 100) * inputCount);
      } else if (msg?.type === 'completed') {
        resolve();
      } else if (msg?.type === 'error') {
        reject(new Error(msg.message));
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`codebaseEmbeddingProcess exited with code ${code}`));
    });
    child.send({ codebaseDirPath, embeddingDirPath, config: { dimensions: 768 }, resume: false });
  });

  const wallMs = Date.now() - started;
  const peakRssMb = rss.stop();
  child.kill();

  const steadyFilesPerMin =
    firstProcessingAt !== null && lastProcessingAt > firstProcessingAt
      ? lastProcessedCount / ((lastProcessingAt - firstProcessingAt) / 60000) || null
      : null;

  const embeddingsWritten = fs.readdirSync(embeddingDirPath).filter((f) => f.endsWith('.embedding.json')).length;

  return { wallMs, modelInitMs, steadyFilesPerMin, peakRssMb, embeddingsWritten };
}

// ── optional docs-embedding stage (createEmbeddingForText.js) ─────────────

async function runDocsStage() {
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wgpt-index-bench-docs-'));
  const embeddingDirPath = path.join(scratchRoot, 'confluence/embeddings');
  fs.mkdirSync(embeddingDirPath, { recursive: true });
  const fileCount = fs.readdirSync(DOCS_CORPUS).filter((f) => f.endsWith('.md')).length;

  const workerData = JSON.stringify({ mdDirPath: DOCS_CORPUS, embeddingDirPath, config: { provider: 'local' }, resume: false });
  const child = fork(DOCS_EMBED_PROCESS, [], { env: { ...process.env, workerData }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const rss = samplePeakRss(child.pid);
  const started = Date.now();

  await new Promise((resolve, reject) => {
    child.on('message', (msg) => {
      if (msg?.type === 'completed') resolve();
      else if (msg?.type === 'error') reject(new Error(msg.message));
    });
    child.on('error', reject);
  });

  const wallMs = Date.now() - started;
  const peakRssMb = rss.stop();
  child.kill();
  fs.rmSync(scratchRoot, { recursive: true, force: true });

  return { wallMs, files: fileCount, filesPerMin: (fileCount / (wallMs / 60000)) || null, peakRssMb };
}

// ── main ───────────────────────────────────────────────────────────────

const id = corpusId(CORPUS_DIR);
log(`index-bench: corpus=${path.relative(pkgRoot, CORPUS_DIR)} (${id}) multiply=${MULTIPLY} stage=${STAGE}`);

const { scratchRoot, repoDir, fileCount } = prepareScratchCorpus(CORPUS_DIR, MULTIPLY);
log(`index-bench: prepared ${fileCount} files in scratch dir`);

const records = [];
const filesDir = path.join(scratchRoot, 'files');
const embeddingsDir = path.join(scratchRoot, 'embeddings');

try {
  if (STAGE === 'collect' || STAGE === 'all') {
    const preflight = await workerBundleLoads(COLLECT_WORKER);
    if (!preflight.ok) {
      log(
        `⚠️  collect: SKIPPED — ${path.relative(repoRoot, COLLECT_WORKER)} fails to even load (${preflight.error}). ` +
          `This is a known pre-existing build defect (duplicate fileURLToPath import from glob/path-scurry), not caused by this benchmark — see the flagged follow-up task.`,
      );
      records.push({
        corpusId: id,
        multiply: MULTIPLY,
        stage: 'collect',
        ranAt: new Date().toISOString(),
        skipped: true,
        error: preflight.error,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      });
    } else {
      const r = await runCollectStage(repoDir, filesDir);
      log(`collect: ${r.filesWritten} files in ${r.wallMs}ms → ${((r.filesWritten / (r.wallMs / 60000)) || 0).toFixed(1)} files/min`);
      records.push({
        corpusId: id,
        multiply: MULTIPLY,
        stage: 'collect',
        ranAt: new Date().toISOString(),
        files: r.filesWritten,
        wallMs: r.wallMs,
        filesPerMin: (r.filesWritten / (r.wallMs / 60000)) || null,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
      });
      if (r.filesWritten !== fileCount) {
        log(`⚠️  collected ${r.filesWritten} files but expected ${fileCount} — check exclude patterns / file-size cap`);
      }
    }
  }

  if (STAGE === 'embed' || STAGE === 'all') {
    if (!fs.existsSync(filesDir) || fs.readdirSync(filesDir).length === 0) {
      // Either --stage embed was requested standalone, or collect above was
      // skipped (broken bundle) — either way the embed stage still deserves
      // real input to benchmark, produced directly instead of via the worker.
      const n = collectFilesDirectly(repoDir, filesDir);
      log(`embed: populated ${n} input files directly (collect stage unavailable${STAGE === 'embed' ? ' — not requested' : ''})`);
    }
    const inputCount = fs.readdirSync(filesDir).length;
    const r = await runEmbedStage(filesDir, embeddingsDir, inputCount);
    log(
      `embed: ${r.embeddingsWritten}/${inputCount} embeddings in ${r.wallMs}ms ` +
        `(model init ${r.modelInitMs ?? '?'}ms, steady ${r.steadyFilesPerMin?.toFixed(1) ?? '?'} files/min, peak RSS ${r.peakRssMb.toFixed(0)}MB)`,
    );
    records.push({
      corpusId: id,
      multiply: MULTIPLY,
      stage: 'embed',
      ranAt: new Date().toISOString(),
      files: inputCount,
      wallMs: r.wallMs,
      modelInitMs: r.modelInitMs,
      filesPerMin: (inputCount / (r.wallMs / 60000)) || null,
      steadyFilesPerMin: r.steadyFilesPerMin,
      peakRssMb: r.peakRssMb,
      embeddingsWritten: r.embeddingsWritten,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    });
    if (r.embeddingsWritten !== inputCount) {
      log(`⚠️  wrote ${r.embeddingsWritten} embeddings but expected ${inputCount} — some files may have failed or exceeded the 1MB text cap`);
    }
  }

  if (WITH_DOCS) {
    const r = await runDocsStage();
    log(`docs: ${r.files} files in ${r.wallMs}ms → ${(r.filesPerMin ?? 0).toFixed(1)} files/min (peak RSS ${r.peakRssMb.toFixed(0)}MB)`);
    records.push({
      corpusId: `docs-corpus@${crypto.createHash('sha256').update(DOCS_CORPUS).digest('hex').slice(0, 6)}`,
      multiply: 1,
      stage: 'docs-embed',
      ranAt: new Date().toISOString(),
      files: r.files,
      wallMs: r.wallMs,
      filesPerMin: r.filesPerMin,
      peakRssMb: r.peakRssMb,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    });
  }
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

// ── results (merge-on-rerun, keyed by corpusId|multiply|stage — see run.mjs) ──

const resultsDir = path.join(pkgRoot, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, 'index-bench.json');
const ranKeys = new Set(records.map((r) => `${r.corpusId}|${r.multiply}|${r.stage}`));
let merged = records;
if (fs.existsSync(jsonPath)) {
  const prior = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  merged = [...prior.filter((r) => !ranKeys.has(`${r.corpusId}|${r.multiply}|${r.stage}`)), ...records];
}
fs.writeFileSync(jsonPath, JSON.stringify(merged, null, 2));

let md = `# Indexing throughput benchmark\n\nRun: ${new Date().toISOString()}\n\n`;
md += `| corpus | multiply | stage | files | wall ms | files/min | steady files/min | peak RSS MB |\n|---|---|---|---|---|---|---|---|\n`;
for (const r of merged) {
  if (r.skipped) {
    md += `| ${r.corpusId} | ${r.multiply} | ${r.stage} | SKIPPED — ${r.error ?? 'unavailable'} ||||| \n`;
    continue;
  }
  md += `| ${r.corpusId} | ${r.multiply} | ${r.stage} | ${r.files} | ${r.wallMs} | ${r.filesPerMin?.toFixed(1) ?? '—'} | ${r.steadyFilesPerMin?.toFixed(1) ?? '—'} | ${r.peakRssMb?.toFixed(0) ?? '—'} |\n`;
}
fs.writeFileSync(path.join(resultsDir, 'index-bench.md'), md);

log(`\nreport → results/index-bench.json, results/index-bench.md`);
process.exit(0);
