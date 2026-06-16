import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import MarkdownIt from 'markdown-it';
import { EmbeddingConfig } from 'src/types/types';
import { MODEL, WORKER_STATUS } from '../../../constants';
import { initializeEmbeddingModel } from '../utils/initializeEmbeddingModel';
import { EmbeddingProvider } from '../../embeddings/EmbeddingProvider';
import { makeEmbeddingProvider } from '../../embeddings/makeProvider';
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

/**
 * Write the combined binary file and delete individual JSON embedding files.
 */
async function writeBinaryAndCleanup(
  allEmbeddings: Array<{ filename: string; text: string; url: string; embedding: number[] }>
): Promise<void> {
  if (allEmbeddings.length === 0) return;

  const dimensions = allEmbeddings[0].embedding.length;

  // Pack all embeddings into a flat Float32Array
  const matrix = new Float32Array(allEmbeddings.length * dimensions);
  const entries: Array<{ filename: string; text: string; url: string; embeddingOffset: number }> = [];

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
    });
  }

  // Write binary matrix
  const binPath = path.join(embeddingDirPath, 'embeddings.bin');
  const buffer = Buffer.from(matrix.buffer, matrix.byteOffset, matrix.byteLength);
  await fs.promises.writeFile(binPath, buffer);

  // Write metadata
  const metaPath = path.join(embeddingDirPath, 'embeddings_meta.json');
  await fs.promises.writeFile(metaPath, JSON.stringify({ dimensions, count: entries.length, entries }));

  // Delete individual JSON files
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

  console.log(`Written binary cache (${entries.length} embeddings). Deleted ${deletedCount} JSON files.`);
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

async function createEmbeddings(): Promise<void> {
  try {
    // Build the embedding provider. Local needs the ONNX model initialized;
    // Gemini just needs an API key. Defaults to local for back-compat.
    const providerId: EmbeddingProviderId = config.provider ?? 'local';
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
      provider = makeEmbeddingProvider({ provider: 'gemini', apiKey: config.apiKey });
    }

    const files = fs
      .readdirSync(mdDirPath)
      .filter((file) => file.endsWith('.md'));
    const total = files.length;

    // Create embeddings directory if it doesn't exist
    if (!fs.existsSync(embeddingDirPath)) {
      fs.mkdirSync(embeddingDirPath, { recursive: true });
    }

    // If resuming, find the starting point
    let startIndex = 0;
    if (resume && lastProcessedFile) {
      startIndex = files.findIndex((file) => file === lastProcessedFile);
      if (startIndex !== -1) {
        startIndex++; // Start from the next file
      }
    }

    // Collect all embeddings (preserved unchanged + newly created); rebuild the binary at the end.
    const allEmbeddings: Array<{ filename: string; text: string; url: string; embedding: number[] }> = [];

    // Load existing embeddings from binary (to preserve unchanged ones across syncs)
    const binPath = path.join(embeddingDirPath, 'embeddings.bin');
    const metaPath = path.join(embeddingDirPath, 'embeddings_meta.json');
    let existingData: Map<string, { text: string; url: string; embedding: number[] }> = new Map();

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
          });
        }
      } catch {
        existingData = new Map();
      }
    }

    // ── Phase 1: classify each file as skip (preserve) or needs-embedding ──
    const toEmbed: Array<{ filename: string; text: string; url: string; srcFile: string }> = [];
    let done = startIndex; // files before startIndex were processed in a prior run

    for (let i = startIndex; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);

      const fileHash = crypto.createHash('sha256').update(file).digest('hex');
      const embeddingFilePath = path.join(embeddingDirPath, `${fileHash}.json`);

      const markdownContent = fs.readFileSync(filePath, 'utf8');
      const { content: cleanContent, frontmatter } = extractFrontmatter(markdownContent);
      const resolvedFilename = frontmatter?.fileName ?? file;

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
            });
          } catch { /* skip if can't read */ }
          done++;
          reportProcessing(done, total, file);
          continue;
        }
      } else if (existingData.has(resolvedFilename)) {
        // Skip 2 (binary): already embedded in a previous sync
        const existing = existingData.get(resolvedFilename)!;
        allEmbeddings.push({
          filename: resolvedFilename,
          text: existing.text,
          url: existing.url,
          embedding: existing.embedding,
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
      });
    }

    // ── Phase 2: embed new content in batches (essential for the Gemini free tier) ──
    const batchSize = provider.maxBatchSize;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const vectors = await provider.embedBatch(batch.map((b) => b.text), 'document');
      for (let j = 0; j < batch.length; j++) {
        allEmbeddings.push({
          filename: batch[j].filename,
          text: batch[j].text,
          url: batch[j].url,
          embedding: vectors[j],
        });
        done++;
      }
      reportProcessing(done, total, batch[batch.length - 1].srcFile);
    }

    // Save the index manifest (compatibility contract + provenance)
    const source = sourceFromPath(embeddingDirPath);
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

    // Write combined binary and clean up individual JSONs
    await writeBinaryAndCleanup(allEmbeddings);

    // Complete
    process.send!({ type: WORKER_STATUS.COMPLETED, total: total });
  } catch (error) {
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
