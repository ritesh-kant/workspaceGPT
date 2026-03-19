import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import MarkdownIt from 'markdown-it';
import { EmbeddingConfig } from 'src/types/types';
import { MODEL, WORKER_STATUS } from '../../../constants';
import { initializeEmbeddingModel } from '../utils/initializeEmbeddingModel';

let md: MarkdownIt;
let extractor: any;

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
 * Load the existing binary meta file to check which files have already been embedded.
 * Returns a Map of filename -> true for quick lookup.
 */
function loadExistingEmbeddingsMeta(): Map<string, boolean> {
  const metaPath = path.join(embeddingDirPath, 'embeddings_meta.json');
  const existing = new Map<string, boolean>();

  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      for (const entry of meta.entries || []) {
        if (entry.filename) {
          existing.set(entry.filename, true);
        }
      }
    }
  } catch {
    // Ignore errors — treat as no existing embeddings
  }

  return existing;
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

async function createEmbeddings(): Promise<void> {
  try {
    // Initialize embedding model first
    extractor = await initializeEmbeddingModel(
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

    const files = fs
      .readdirSync(mdDirPath)
      .filter((file) => file.endsWith('.md'));
    const total = files.length;

    // Create embeddings directory if it doesn't exist
    if (!fs.existsSync(embeddingDirPath)) {
      fs.mkdirSync(embeddingDirPath, { recursive: true });
    }

    // Load existing embeddings from binary meta for incremental sync
    const existingEmbeddings = loadExistingEmbeddingsMeta();

    // If resuming, find the starting point
    let startIndex = 0;
    if (resume && lastProcessedFile) {
      startIndex = files.findIndex((file) => file === lastProcessedFile);
      if (startIndex !== -1) {
        startIndex++; // Start from the next file
      }
    }

    // Collect all embeddings (existing from binary meta + newly created)
    // We'll rebuild the full binary at the end
    const allEmbeddings: Array<{ filename: string; text: string; url: string; embedding: number[] }> = [];

    // Load existing embeddings from binary if available (to preserve unchanged ones)
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
          const embedding = Array.from(matrix.slice(offset, offset + dim));
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

    // Process each file
    for (let i = startIndex; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);

      // We will save embeddings using a hash of the filename to support incremental updates
      const fileHash = crypto.createHash('sha256').update(file).digest('hex');
      const embeddingFilePath = path.join(embeddingDirPath, `${fileHash}.json`);

      // Check for incremental embedding skipping:
      // 1. Check individual JSON file (legacy)
      // 2. Check binary meta (new)
      const markdownContent = fs.readFileSync(filePath, 'utf8');
      const { content: cleanContent, frontmatter } = extractFrontmatter(markdownContent);
      const resolvedFilename = frontmatter?.fileName ?? file;

      // Check if we can skip this file (already embedded and unchanged)
      if (fs.existsSync(embeddingFilePath)) {
        // Legacy: individual JSON file exists
        const mdStat = fs.statSync(filePath);
        const embedStat = fs.statSync(embeddingFilePath);

        if (embedStat.mtimeMs > mdStat.mtimeMs) {
          console.log(`Skipping unchanged file (JSON): ${file}`);
          // Read existing embedding from JSON to include in the binary
          try {
            const existing = JSON.parse(fs.readFileSync(embeddingFilePath, 'utf8'));
            allEmbeddings.push({
              filename: existing.filename,
              text: existing.text,
              url: existing.url,
              embedding: existing.embedding,
            });
          } catch { /* skip if can't read */ }

          const currentProgress = resume && processedFiles ? i + 1 - startIndex + processedFiles : i + 1;
          process.send!({
            type: WORKER_STATUS.PROCESSING,
            progress: ((currentProgress / total) * 100).toFixed(1),
            current: currentProgress,
            total,
            lastProcessedFile: file,
          });
          continue;
        }
      } else if (existingData.has(resolvedFilename)) {
        // New: check binary meta — file was already embedded
        console.log(`Skipping unchanged file (binary): ${file}`);
        const existing = existingData.get(resolvedFilename)!;
        allEmbeddings.push({
          filename: resolvedFilename,
          text: existing.text,
          url: existing.url,
          embedding: existing.embedding,
        });

        const currentProgress = resume && processedFiles ? i + 1 - startIndex + processedFiles : i + 1;
        process.send!({
          type: WORKER_STATUS.PROCESSING,
          progress: ((currentProgress / total) * 100).toFixed(1),
          current: currentProgress,
          total,
          lastProcessedFile: file,
        });
        continue;
      }

      // Log metadata if found
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        console.log(`Extracted metadata from ${file}:`, frontmatter);
      }

      // Convert markdown to structured plain text
      const content = md
        .render(cleanContent)
        .replace(/<[^>]*>/g, '')
        .trim();

      // Create embedding for the content
      const embedding = await createEmbeddingForText(content);

      // Collect for binary write
      allEmbeddings.push({
        filename: resolvedFilename,
        text: content,
        url: frontmatter?.url ?? '',
        embedding,
      });

      // Report progress
      const currentProgress =
        resume && processedFiles ? i + 1 - startIndex + processedFiles : i + 1;
      process.send!({
        type: WORKER_STATUS.PROCESSING,
        progress: ((currentProgress / total) * 100).toFixed(1),
        current: currentProgress,
        total,
        lastProcessedFile: file,
      });
    }

    // Save index metadata
    fs.writeFileSync(
      path.join(embeddingDirPath, 'index.json'),
      JSON.stringify({
        total: total,
        dimensions: config.dimensions,
        includesMetadata: true,
        metadataFields: ['url', 'frontmatter'],
      })
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

// Create embedding using transformer model
async function createEmbeddingForText(text: string): Promise<number[]> {
  try {
    // console.log(`Generating embedding for text of length ${text.length}...`);

    if (!extractor) {
      throw new Error('Embedding model not initialized');
    }

    const startTime = Date.now();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const duration = Date.now() - startTime;

    // console.log(`Embedding generation completed in ${duration}ms`);
    // console.log(`Generated embedding with ${output.data.length} dimensions`);

    return Array.from(output.data);
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
createEmbeddings();
