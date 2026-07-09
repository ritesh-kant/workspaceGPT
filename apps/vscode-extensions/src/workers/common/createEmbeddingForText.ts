import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import MarkdownIt from 'markdown-it';
import { EmbeddingConfig } from 'src/types/types';
import { MODEL, WORKER_STATUS } from '../../../constants';
import { initializeEmbeddingModel } from '../utils/initializeEmbeddingModel';
import { EmbeddingProvider } from '../../embeddings/EmbeddingProvider';
import { makeEmbeddingProvider } from '../../embeddings/makeProvider';
import { makeVectorStore } from '../../vectorstore/makeVectorStore';
import {
  EmbeddingIndexManifest,
  EmbeddingProviderId,
} from '../../types/embeddingManifest';

let md: MarkdownIt;
let provider: EmbeddingProvider;

interface WorkerData {
  mdDirPath: string;
  embeddingDirPath: string;
  config: EmbeddingConfig;
  resume?: boolean;
  lastProcessedFile?: string;
  processedFiles?: number;
}

interface Metadata {
  id: number;
  filename: string;
  text: string;
  embedding: number[];
  url?: string;
  frontmatter?: Record<string, any>;
}
let workerData;
const workerDataStr = process.env.workerData;
workerData = JSON.parse(workerDataStr!);

const {
  mdDirPath,
  embeddingDirPath,
  config,
  resume,
  lastProcessedFile,
  processedFiles,
} = workerData;

// Initialize markdown-it
md = new MarkdownIt({ html: false });

/**
 * Extracts frontmatter metadata from markdown content
 * @param markdownContent The raw markdown content
 * @returns Object containing cleaned content and extracted frontmatter
 */
function extractFrontmatter(markdownContent: string): {
  content: string;
  frontmatter?: Record<string, any>;
} {
  // Check if content has frontmatter (starts with ---)
  if (!markdownContent || !markdownContent.trim().startsWith('---')) {
    return { content: markdownContent || '' };
  }

  try {
    // Find the second --- that closes the frontmatter block
    const secondDashIndex = markdownContent.indexOf('---', 3);
    if (secondDashIndex === -1) {
      return { content: markdownContent };
    }

    // Extract the frontmatter content
    const frontmatterRaw = markdownContent.substring(3, secondDashIndex).trim();
    const content = markdownContent.substring(secondDashIndex + 3).trim();

    // Parse the frontmatter as key-value pairs
    const frontmatter: Record<string, any> = {};
    frontmatterRaw.split('\n').forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith('#')) {
        const colonIndex = trimmedLine.indexOf(':');
        if (colonIndex !== -1) {
          const key = trimmedLine.substring(0, colonIndex).trim();
          const value = trimmedLine.substring(colonIndex + 1).trim();
          if (key && value) {
            frontmatter[key] = value;
          }
        }
      }
    });

    return {
      content,
      frontmatter:
        Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
    };
  } catch (error) {
    console.error('Error parsing frontmatter:', error);
    return { content: markdownContent };
  }
}

type EmbeddingRow = { filename: string; text: string; url: string; embedding: number[]; contentHash: string };

/**
 * Write the combined binary file (embeddings.bin + embeddings_meta.json).
 * Safe to call repeatedly mid-run for checkpointing — it rewrites the whole
 * cache from the in-memory array each time.
 */
async function writeBinary(allEmbeddings: EmbeddingRow[]): Promise<void> {
  if (allEmbeddings.length === 0) return;

  const dimensions = allEmbeddings[0].embedding.length;

  // Pack all embeddings into a flat Float32Array
  const matrix = new Float32Array(allEmbeddings.length * dimensions);
  const entries: Array<{ filename: string; text: string; url: string; embeddingOffset: number; contentHash: string }> = [];

  for (let i = 0; i < allEmbeddings.length; i++) {
    const offset = i * dimensions;
    const emb = allEmbeddings[i].embedding;
    for (let j = 0; j < dimensions; j++) {
      matrix[offset + j] = emb[j];
    }
    entries.push({
      filename: allEmbeddings[i].filename,
      text: allEmbeddings[i].text,
      url: allEmbeddings[i].url,
      embeddingOffset: offset,
      contentHash: allEmbeddings[i].contentHash,
    });
  }

  // Write binary matrix
  const binPath = path.join(embeddingDirPath, 'embeddings.bin');
  const buffer = Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength);
  await fs.promises.writeFile(binPath, buffer);

  // Write metadata
  const metaPath = path.join(embeddingDirPath, 'embeddings_meta.json');
  await fs.promises.writeFile(metaPath, JSON.stringify({ dimensions, count: entries.length, entries }));
}

/** Delete leftover individual JSON embedding files (legacy format). */
async function cleanupJsonFiles(): Promise<void> {
  const keepFiles = new Set(['index.json', 'embeddings_meta.json']);
  const files = await fs.promises.readdir(embeddingDirPath);
  const jsonFiles = files.filter(f => f.endsWith('.json') && !keepFiles.has(f));

  let deletedCount = 0;
  await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        await fs.promises.unlink(path.join(embeddingDirPath, file));
        deletedCount++;
      } catch { /* ignore */ }
    })
  );
  if (deletedCount > 0) console.log(`Deleted ${deletedCount} legacy JSON files.`);
}

/** Write the binary cache and clean up legacy JSONs (final write at end of run). */
async function writeBinaryAndCleanup(allEmbeddings: EmbeddingRow[]): Promise<void> {
  await writeBinary(allEmbeddings);
  await cleanupJsonFiles();
  console.log(`Written binary cache (${allEmbeddings.length} embeddings).`);
}

/** Progress message helper — keeps the shape the embedding services expect. */
function reportProcessing(current: number, total: number, lastProcessedFile?: string) {
  process.send!({
    type: WORKER_STATUS.PROCESSING,
    progress: total > 0 ? ((current / total) * 100).toFixed(1) : '0',
    current,
    total,
    lastProcessedFile,
  });
}

/** Greppable diagnostic logger so we can trace local-vs-cloud decisions. */
function diag(...args: any[]) {
  console.log('[workspaceGPT][embedding]', ...args);
}

/** Mask a secret for safe logging (keep first/last few chars). */
function mask(secret?: string): string {
  if (!secret) return '(none)';
  if (secret.length <= 8) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (len=${secret.length})`;
}

async function createEmbeddings(): Promise<void> {
  try {
    // Build the embedding provider. Local needs the ONNX model initialized;
    // Gemini just needs an API key. Defaults to local for back-compat.
    const providerId: EmbeddingProviderId = config.provider ?? 'local';

    // ── Diagnostics: what did this worker actually receive? ──
    diag('────────────────────────────────────────────────────');
    diag(`mdDirPath=${mdDirPath}`);
    diag(`embeddingDirPath=${embeddingDirPath}`);
    diag(
      `EMBEDDING provider = ${providerId.toUpperCase()} ` +
        `(${providerId === 'local' ? 'LOCAL ONNX / Xenova' : 'CLOUD / Gemini API'})`,
    );
    if (providerId === 'gemini') {
      diag(`  gemini apiKey = ${mask(config.apiKey)}`);
    }
    diag(
      `VECTOR STORE location = ${(config.vectorStore?.location ?? 'local').toUpperCase()} ` +
        `(${config.vectorStore?.location === 'cloud' ? 'CLOUD / Qdrant' : 'LOCAL file-based .bin'})`,
    );
    if (config.vectorStore?.location === 'cloud') {
      diag(`  qdrant url    = ${config.vectorStore.qdrantUrl || '(MISSING!)'}`);
      diag(`  qdrant apiKey = ${mask(config.vectorStore.qdrantApiKey)}`);
    } else {
      diag(
        '  ⚠ vectorStore.location is NOT "cloud" — embeddings will be written to ' +
          'the local .bin file ONLY and nothing will be pushed to Qdrant. ' +
          'If you expect data in Qdrant, check the Settings panel (vector store = Cloud) ' +
          'and that the setting was saved before syncing.',
      );
    }

    if (providerId === 'local') {
      const extractor = await initializeEmbeddingModel(
        MODEL.DEFAULT_TEXT_EMBEDDING_MODEL,
        embeddingDirPath,
        (progress: any) => {
          process.send!({
            type: WORKER_STATUS.PROCESSING,
            progress: progress.progress || 0,
            message: progress.message || 'Initializing model...',
          });
        }
      );
      provider = makeEmbeddingProvider({ provider: 'local', extractor });
    } else {
      provider = makeEmbeddingProvider({ provider: 'gemini', apiKey: config.apiKey, apiKeys: config.apiKeys });
    }

    const files = fs
      .readdirSync(mdDirPath)
      .filter((file) => file.endsWith('.md'));
    const total = files.length;

    // Create embeddings directory if it doesn't exist
    if (!fs.existsSync(embeddingDirPath)) {
      fs.mkdirSync(embeddingDirPath, { recursive: true });
    }

    // Resume no longer slices at lastProcessedFile: the content-hash skip below
    // preserves already-embedded files at the cost of a hash, and slicing dropped
    // every entry before the slice point when the binary was rewritten at the end.
    const startIndex = 0;

    // Collect all embeddings (preserved unchanged + newly created); rebuild the binary at the end.
    const allEmbeddings: EmbeddingRow[] = [];

    // Load existing embeddings from binary (to preserve unchanged ones across syncs)
    const binPath = path.join(embeddingDirPath, 'embeddings.bin');
    const metaPath = path.join(embeddingDirPath, 'embeddings_meta.json');
    let existingData: Map<string, { text: string; url: string; embedding: number[]; contentHash?: string }> = new Map();

    if (fs.existsSync(binPath) && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const buffer = fs.readFileSync(binPath);
        const matrix = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
        const dim = meta.dimensions;

        for (const entry of meta.entries) {
          const offset = entry.embeddingOffset;
          const embedding = Array.from(matrix.slice(offset, offset + dim)) as number[];
          existingData.set(entry.filename, {
            text: entry.text,
            url: entry.url,
            embedding,
            contentHash: entry.contentHash,
          });
        }
      } catch {
        existingData = new Map();
      }
    }

    // ── Phase 1: classify each file as skip (preserve) or needs-embedding ──
    const toEmbed: Array<{ filename: string; text: string; url: string; srcFile: string; contentHash: string }> = [];
    let done = startIndex; // files before startIndex were processed in a prior run

    for (let i = startIndex; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);

      const fileHash = crypto.createHash('sha256').update(file).digest('hex');
      const embeddingFilePath = path.join(embeddingDirPath, `${fileHash}.json`);

      const markdownContent = fs.readFileSync(filePath, 'utf8');
      const { content: cleanContent, frontmatter } = extractFrontmatter(markdownContent);
      const resolvedFilename = frontmatter?.fileName ?? file;
      const contentHash = crypto.createHash('sha256').update(markdownContent).digest('hex');

      // Skip 1 (legacy): individual JSON file exists and is newer than the markdown
      if (fs.existsSync(embeddingFilePath)) {
        const mdStat = fs.statSync(filePath);
        const embedStat = fs.statSync(embeddingFilePath);
        if (embedStat.mtimeMs > mdStat.mtimeMs) {
          try {
            const existing = JSON.parse(fs.readFileSync(embeddingFilePath, 'utf8'));
            allEmbeddings.push({
              filename: existing.filename,
              text: existing.text,
              url: existing.url,
              embedding: existing.embedding,
              // md is older than the embedding, so the current file content is
              // what was embedded — its hash is valid for this entry.
              contentHash,
            });
          } catch { /* skip if can't read */ }
          done++;
          reportProcessing(done, total, file);
          continue;
        }
      } else if (existingData.get(resolvedFilename)?.contentHash === contentHash) {
        // Skip 2 (binary): already embedded and the source content is unchanged.
        // Entries from indexes built before contentHash existed never match,
        // so they get re-embedded once — this also flushes any stale entries
        // preserved by the old filename-only skip.
        const existing = existingData.get(resolvedFilename)!;
        allEmbeddings.push({
          filename: resolvedFilename,
          text: existing.text,
          url: existing.url,
          embedding: existing.embedding,
          contentHash,
        });
        done++;
        reportProcessing(done, total, file);
        continue;
      }

      // Needs embedding — convert markdown to structured plain text
      const content = md
        .render(cleanContent)
        .replace(/<[^>]*>/g, '')
        .trim();
      toEmbed.push({
        filename: resolvedFilename,
        text: content,
        url: frontmatter?.url ?? '',
        srcFile: file,
        contentHash,
      });
    }

    diag(
      `classified ${files.length} md files → ${toEmbed.length} need embedding, ` +
        `${allEmbeddings.length} preserved from previous sync ` +
        `(provider.maxBatchSize=${provider.maxBatchSize}, dims=${provider.identity.dimensions})`,
    );

    const source = sourceFromPath(embeddingDirPath);

    // Helper: persist the manifest (compatibility contract + provenance).
    const writeManifest = () => {
      const manifest: EmbeddingIndexManifest = {
        schemaVersion: 1,
        embedding: provider.identity,
        docTaskType:
          provider.identity.provider === 'gemini' ? 'RETRIEVAL_DOCUMENT' : undefined,
        source,
        count: allEmbeddings.length,
        builtAt: new Date().toISOString(),
        builtBy: 'vscode-extension',
        shareable: provider.identity.provider === 'gemini',
        // legacy fields kept for existing readers
        total,
        dimensions: provider.identity.dimensions,
        includesMetadata: true,
        metadataFields: ['url', 'frontmatter'],
      };
      fs.writeFileSync(
        path.join(embeddingDirPath, 'index.json'),
        JSON.stringify(manifest)
      );
    };

    // ── Cloud setup (once) ──
    // When cloud-backed, create/verify the collection up front and push any
    // preserved embeddings so Qdrant stays complete even if this run dies early.
    let store: ReturnType<typeof makeVectorStore> = null;
    let cloudUpserted = 0; // how many of allEmbeddings are already in Qdrant
    const toRecords = (rows: EmbeddingRow[]) =>
      rows.map((e) => ({
        id: `${source}:${e.filename}`,
        vector: e.embedding,
        payload: { text: e.text, fileName: e.filename, url: e.url, sourceName: source },
      }));

    if (config.vectorStore?.location === 'cloud') {
      if (!config.vectorStore.qdrantUrl) {
        diag('  ⚠ qdrantUrl is empty — cannot upload to Qdrant. Check Settings.');
      }
      store = makeVectorStore({
        location: 'cloud',
        qdrant: {
          url: config.vectorStore.qdrantUrl!,
          apiKey: config.vectorStore.qdrantApiKey,
        },
      });
      if (store) {
        diag(`CLOUD: ensuring collection for source="${source}" (dims=${provider.identity.dimensions}) …`);
        await store.ensure(provider.identity, source);
        if (allEmbeddings.length > 0) {
          diag(`CLOUD: upserting ${allEmbeddings.length} preserved points …`);
          await store.upsert(toRecords(allEmbeddings), source);
          cloudUpserted = allEmbeddings.length;
        }
      } else {
        diag('  ⚠ makeVectorStore returned null — nothing will be uploaded to Qdrant.');
      }
    } else {
      diag('LOCAL storage only — Qdrant will NOT be touched.');
    }

    // Checkpoint: flush local binary + manifest, then mirror new rows to cloud.
    // Local is written BEFORE cloud so on-disk progress survives a cloud failure.
    const checkpoint = async () => {
      writeManifest();
      await writeBinary(allEmbeddings);
      if (store && allEmbeddings.length > cloudUpserted) {
        const fresh = allEmbeddings.slice(cloudUpserted);
        await store.upsert(toRecords(fresh), source);
        cloudUpserted = allEmbeddings.length;
      }
    };

    // ── Phase 2: embed new content in batches, checkpointing after each batch ──
    // Per-batch checkpointing means a quota cut-off (e.g. Gemini's 1000/day free
    // limit) keeps everything embedded so far; the next run skips it and resumes.
    const batchSize = provider.maxBatchSize;
    if (toEmbed.length === 0) {
      diag('nothing new to embed — finalizing.');
    }
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await provider.embedBatch(batch.map((b) => b.text), 'document');
      for (let j = 0; j < batch.length; j++) {
        allEmbeddings.push({
          filename: batch[j].filename,
          text: batch[j].text,
          url: batch[j].url,
          embedding: vectors[j],
          contentHash: batch[j].contentHash,
        });
        done++;
      }
      await checkpoint();
      diag(`checkpoint: ${allEmbeddings.length} embeddings persisted` + (store ? ` (${cloudUpserted} in Qdrant)` : ''));
      reportProcessing(done, total, batch[batch.length - 1].srcFile);
    }

    // Final write: ensure manifest/binary reflect the full set and drop legacy JSONs.
    writeManifest();
    await writeBinaryAndCleanup(allEmbeddings);

    // Complete
    diag(`done — ${allEmbeddings.length} embeddings total` + (store ? `, ${cloudUpserted} in Qdrant.` : '.'));
    process.send!({ type: WORKER_STATUS.COMPLETED, total: total });
  } catch (error) {
    diag('✗ ERROR (progress checkpointed up to last completed batch):',
      error instanceof Error ? error.stack || error.message : String(error));
    process.send!({
      type: WORKER_STATUS.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Derive the index source from the embedding directory path (…/confluence/embeddings). */
function sourceFromPath(embeddingDirPath: string): EmbeddingIndexManifest['source'] {
  const parent = path.basename(path.dirname(embeddingDirPath)).toLowerCase();
  if (parent === 'ado') return 'ADO';
  if (parent === 'codebase') return 'CODEBASE';
  return 'CONFLUENCE';
}

// Start processing
createEmbeddings();
