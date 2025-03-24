import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { HierarchicalNSW } from 'hnswlib-node';

let pipeline: any;
let transformers: any;
let extractor: any;

interface WorkerData {
  mdDirPath: string;
  embeddingDirPath: string;
  config: {
    dimensions: number;
    maxElements: number;
  };
}

interface Metadata {
  id: number;
  filename: string;
  text: string;
}

const { mdDirPath, embeddingDirPath, config } = workerData as WorkerData;

async function createEmbeddings(): Promise<void> {
  try {
    // Initialize HNSW index
    const index = new HierarchicalNSW('cosine', config.dimensions);
    index.initIndex(config.maxElements);

    // Read all MD files
    const files = fs
      .readdirSync(mdDirPath)
      .filter((file) => file.endsWith('.md'));
    const total = files.length;

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);
      const content = fs.readFileSync(filePath, 'utf8');

      // Create embedding for the content using all-MiniLM-L6-v2
      const embedding = await createEmbeddingForText(content);

      // Add to index
      index.addPoint(embedding, i);

      // Store metadata
      const metadata: Metadata = {
        id: i,
        filename: file,
        text: content,
      };

      // Save metadata
      fs.writeFileSync(
        path.join(embeddingDirPath, `${i}.json`),
        JSON.stringify(metadata)
      );

      // Report progress
      parentPort?.postMessage({
        type: 'progress',
        progress: ((i + 1) / total) * 100,
        current: i + 1,
        total,
      });
    }

    // Save the index
    const indexPath = path.join(embeddingDirPath, 'index.bin');
    index.writeIndex(indexPath);

    // Complete
    parentPort?.postMessage({ type: 'complete' });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Create embedding using all-MiniLM-L6-v2 model
async function createEmbeddingForText(text: string): Promise<number[]> {
  // Using dynamic import for ESM compatibility
  const importModule = new Function('modulePath', 'return import(modulePath)');
  try {
    if (!extractor) {
      //   transformers = await import('@xenova/transformers');
      transformers = await importModule('@xenova/transformers');

      pipeline = transformers.pipeline;
      extractor = await pipeline(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      );
    }
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data).map(Number);
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
createEmbeddings();
