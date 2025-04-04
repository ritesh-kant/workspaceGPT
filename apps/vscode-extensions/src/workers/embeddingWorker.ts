import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import MarkdownIt from 'markdown-it';
import { EmbeddingConfig } from 'src/types/types';
import { MODEL, WORKER_STATUS } from '../../constants';

let md: MarkdownIt;
let ollamaModel: string;

interface WorkerData {
  mdDirPath: string;
  embeddingDirPath: string;
  config: EmbeddingConfig;
}

interface Metadata {
  id: number;
  filename: string;
  text: string;
  embedding: number[];
}

const { mdDirPath, embeddingDirPath, config } = workerData as WorkerData;

// Initialize markdown-it
md = new MarkdownIt({ html: false });

async function createEmbeddings(): Promise<void> {
  try {
    const files = fs
      .readdirSync(mdDirPath)
      .filter((file) => file.endsWith('.md'));
    const total = files.length;

    // Create embeddings directory if it doesn't exist
    if (!fs.existsSync(embeddingDirPath)) {
      fs.mkdirSync(embeddingDirPath, { recursive: true });
    }

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);
      const markdownContent = fs.readFileSync(filePath, 'utf8');
      // Convert markdown to structured plain text
      const content = md
        .render(markdownContent)
        .replace(/<[^>]*>/g, '')
        .trim();

      // Create embedding for the content using all-MiniLM-L6-v2
      const embedding = await createEmbeddingForText(content);

      // Store metadata with embedding
      const metadata: Metadata = {
        id: i,
        filename: file,
        text: content,
        embedding: embedding
      };

      // Save metadata
      fs.writeFileSync(
        path.join(embeddingDirPath, `${i}.json`),
        JSON.stringify(metadata)
      );

      // Report progress
      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSING,
        progress: (((i + 1) / total) * 100).toFixed(1),
        current: i + 1,
        total,
      });
    }

    // Save index metadata
    fs.writeFileSync(
      path.join(embeddingDirPath, 'index.json'),
      JSON.stringify({
        total: total,
        dimensions: config.dimensions
      })
    );

    // Complete
    parentPort?.postMessage({ type: WORKER_STATUS.COMPLETED });
    console.log('Embeddings created successfully!');
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Create embedding using Ollama API
async function createEmbeddingForText(
  text: string,
): Promise<number[]> {
  try {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL.DEFAULT_OLLAMA_EMBEDDING_MODEL,
        prompt: text
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to generate embeddings: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (!result.embedding || !Array.isArray(result.embedding)) {
      throw new Error('Invalid embedding response from Ollama');
    }
    
    return result.embedding;
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
createEmbeddings();
