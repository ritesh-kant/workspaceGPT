import { workerData, parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { WORKER_STATUS } from '../../../constants';

interface WorkerData {
  codebaseDirPath: string;
  embeddingDirPath: string;
  config: { dimensions: number };
  resume: boolean;
}

interface ProcessedFile {
  filename: string;
  text: string;
  filePath: string;
}

interface EmbeddingData {
  filename: string;
  filePath: string;
  dimensions: number;
  embedding: number[];
}
const importModule = new Function('modulePath', 'return import(modulePath)');
const { codebaseDirPath, embeddingDirPath, config, resume } = workerData as WorkerData;
let extractor: any;

async function initializeModel() {
  try {
    const { pipeline } = await importModule('@xenova/transformers');
    // Add model options with local_files_only set to false to allow downloading if needed
    // and add a longer timeout to handle potential network issues
    extractor = await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code', {
      local_files_only: false,
      revision: 'main',
      quantized: false,
      cache_dir: path.join(embeddingDirPath, '.cache', 'transformers'),
      progress_callback: (progress: any) => {
        if (progress.status === 'progress' && parentPort) {
          parentPort.postMessage({
            type: WORKER_STATUS.PROCESSING,
            progress: Math.round(progress.progress),
            message: `Downloading model: ${Math.round(progress.progress)}%`
          });
        }
      }
    });
  } catch (error) {
    throw new Error(`Failed to initialize model: ${(error as Error).message}`);
  }
}

async function getProcessedFiles(): Promise<Set<string>> {
  if (!resume) return new Set();
  
  try {
    const files = await fs.promises.readdir(embeddingDirPath, { recursive: true });
    return new Set(
      files
        .filter(file => file.endsWith('.embedding.json'))
        .map(file => file.slice(0, -5))
    );
  } catch {
    return new Set();
  }
}

async function readFileContent(filePath: string): Promise<ProcessedFile | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return {
      filename: data.filename,
      filePath: data.filePath,
      text: data.text
    };
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return null;
  }
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data);
  } catch (error) {
    console.error('Error generating embedding:', error);
    return null;
  }
}

async function saveEmbedding(data: EmbeddingData): Promise<void> {
  const embeddingFilePath = path.join(embeddingDirPath, `${data.filename}.embedding.json`);
  await fs.promises.mkdir(path.dirname(embeddingFilePath), { recursive: true });
  await fs.promises.writeFile(embeddingFilePath, JSON.stringify(data));
}

async function processFile(file: ProcessedFile): Promise<void> {
  if (file.text.length > 1000000) {
    console.log(`Skipping large file: ${file.filePath}`);
    return;
  }

  const embedding = await generateEmbedding(file.text);
  if (!embedding) return;

  await saveEmbedding({
    filename: file.filename,
    filePath: file.filePath,
    dimensions: embedding.length,
    embedding
  });
}

async function processFiles(files: ProcessedFile[]): Promise<void> {
  let processedCount = 0;
  const totalFiles = files.length;

  for (const file of files) {
    await processFile(file);
    processedCount++;

    if (processedCount % 10 === 0 || processedCount === totalFiles) {
      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSING,
        progress: Math.round((processedCount / totalFiles) * 100),
        message: `Processed ${processedCount} of ${totalFiles} files`
      });
    }
  }
}

async function collectFiles(dirPath: string, processedPaths: Set<string>): Promise<ProcessedFile[]> {
  const files: ProcessedFile[] = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    
    if (entry.isDirectory()) {
      const subFiles = await collectFiles(fullPath, processedPaths);
      files.push(...subFiles);
      continue;
    }

    if (resume && processedPaths.has(fullPath)) {
      console.log(`Skipping processed file: ${fullPath}`);
      continue;
    }

    const file = await readFileContent(fullPath);
    if (file) files.push(file);
  }

  return files;
}

async function processEmbeddings(): Promise<void> {
  try {
    await fs.promises.access(codebaseDirPath);
    await fs.promises.mkdir(embeddingDirPath, { recursive: true });
    await initializeModel();

    const processedPaths = await getProcessedFiles();
    const files = await collectFiles(codebaseDirPath, processedPaths);

    if (files.length === 0) {
      console.log(resume ? 'All files processed' : 'No files to process');
      parentPort?.postMessage({ type: WORKER_STATUS.COMPLETED, message: 'No files to process' });
      return;
    }

    await processFiles(files);
    parentPort?.postMessage({ type: WORKER_STATUS.COMPLETED, message: 'Embedding complete' });

  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: `Error: ${(error as Error).message}`
    });
  }
}

processEmbeddings();