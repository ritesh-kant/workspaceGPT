import fs from 'fs';
import path from 'path';
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

async function createEmbeddings(): Promise<void> {
  try {
    // Initialize embedding model first
    // console.log('Confluence: Initializing embedding model...');
    extractor = await initializeEmbeddingModel(
      MODEL.DEFAULT_TEXT_EMBEDDING_MODEL,
      embeddingDirPath,
      (progress: any) => {
        // console.log('Model download progress:', progress);
        process.send!({
          type: WORKER_STATUS.PROCESSING,
          progress: progress.progress || 0,
          message: progress.message || 'Initializing model...',
        });
      }
    );
    // console.log('Confluence: Model initialization complete');

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

    // Process each file
    for (let i = startIndex; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);
      const markdownContent = fs.readFileSync(filePath, 'utf8');

      // Extract frontmatter metadata if present
      const { content: cleanContent, frontmatter } =
        extractFrontmatter(markdownContent);

      // Log metadata if found
      if (frontmatter && Object.keys(frontmatter).length > 0) {
        // console.log(`Extracted metadata from ${file}:`, frontmatter);
      }

      // Convert markdown to structured plain text
      const content = md
        .render(cleanContent)
        .replace(/<[^>]*>/g, '')
        .trim();

      // Create embedding for the content using Xenova/all-MiniLM-L6-v2
      const embedding = await createEmbeddingForText(content);

      // Store metadata with embedding
      const metadata: Metadata = {
        id: i,
        filename: file,
        text: content,
        embedding: embedding,
        url: frontmatter?.url,
      };

      // Save metadata
      fs.writeFileSync(
        path.join(embeddingDirPath, `${i}.json`),
        JSON.stringify(metadata)
      );

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
