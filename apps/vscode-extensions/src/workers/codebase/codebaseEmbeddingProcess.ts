import * as fs from 'fs';
import * as path from 'path';

import { MODEL, WORKER_STATUS } from '../../../constants';
import { initializeEmbeddingModel } from 'src/utils/initializeEmbeddingModel';

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
  text: string; // Store the original text for future reference
  embedding: number[];
}
let codebaseDirPath: string;
let embeddingDirPath: string;
let config: { dimensions: number };
let resume: boolean;
let extractor: any;

async function getProcessedFiles(): Promise<Set<string>> {
  if (!resume) return new Set();

  try {
    const files = await fs.promises.readdir(embeddingDirPath, {
      recursive: true,
    });
    return new Set(
      files
        .filter((file) => file.endsWith('.embedding.json'))
        .map((file) => file.slice(0, -5))
    );
  } catch {
    return new Set();
  }
}

async function readFileContent(
  filePath: string
): Promise<ProcessedFile | null> {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return {
      filename: data.filename,
      filePath: data.filePath,
      text: data.text,
    };
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return null;
  }
}

async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    console.log(`Generating embedding for text of length ${text.length}...`);
    console.log('Using extractor with pooling: mean, normalize: true');

    const startTime = Date.now();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const duration = Date.now() - startTime;

    console.log(`Embedding generation completed in ${duration}ms`);
    console.log(`Generated embedding with ${output.data.length} dimensions`);

    return Array.from(output.data);
  } catch (error) {
    console.error('Error generating embedding:', error);
    console.error('Stack trace:', (error as Error).stack);
    return null;
  }
}

async function saveEmbedding(data: EmbeddingData): Promise<void> {
  const embeddingFilePath = path.join(
    embeddingDirPath,
    `${data.filename}.embedding.json`
  );
  await fs.promises.mkdir(path.dirname(embeddingFilePath), { recursive: true });
  await fs.promises.writeFile(embeddingFilePath, JSON.stringify(data));
}

async function processFile(file: ProcessedFile): Promise<void> {
  console.log(
    `Processing file: ${file.filePath} (size: ${file.text.length} chars)`
  );

  if (file.text.length > 1000000) {
    console.log(`Skipping large file: ${file.filePath} - exceeds size limit`);
    return;
  }

  console.log(`Generating embedding for: ${file.filePath}`);
  const embedding = await generateEmbedding(file.text);

  if (!embedding) {
    console.error(`Failed to generate embedding for: ${file.filePath}`);
    return;
  }

  console.log(
    `Successfully generated embedding for file: ${file.filePath} (dimensions: ${embedding.length})`
  );
  await saveEmbedding({
    filename: file.filename,
    filePath: file.filePath,
    dimensions: embedding.length,
    text: file.text, // Store the original text for future reference
    embedding,
  });
  console.log(`Saved embedding for: ${file.filePath}`);
}

async function processFiles(files: ProcessedFile[]): Promise<void> {
  let processedCount = 0;
  const totalFiles = files.length;

  for (const file of files) {
    await processFile(file);
    processedCount++;

    // TODO: check progress bar
    if (processedCount % 10 === 0) {
      process.send?.({
        type: WORKER_STATUS.PROCESSING,
        progress: Math.round((processedCount / totalFiles) * 100),
        message: `Processed ${processedCount} of ${totalFiles} files`,
      });
    }
  }
}

async function collectFiles(
  dirPath: string,
  processedPaths: Set<string>
): Promise<ProcessedFile[]> {
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
    console.log('Starting embedding process...');
    console.log('Checking access to codebase directory:', codebaseDirPath);
    await fs.promises.access(codebaseDirPath);

    console.log('Creating embedding directory:', embeddingDirPath);
    await fs.promises.mkdir(embeddingDirPath, { recursive: true });

    console.log('Initializing embedding model...');
    extractor = await initializeEmbeddingModel(
      MODEL.DEFAULT_CODE_EMBEDDING_MODEL,
      embeddingDirPath,
      (progress: any) => {
        console.log(progress);
      }
    );
    console.log('Model initialization complete');

    console.log('Getting list of already processed files...');
    const processedPaths = await getProcessedFiles();
    console.log(`Found ${processedPaths.size} already processed files`);

    console.log('Collecting files to process from:', codebaseDirPath);
    const files = await collectFiles(codebaseDirPath, processedPaths);
    console.log(`Collected ${files.length} files to process`);

    if (!files.length) {
      const message = resume
        ? 'All files already processed'
        : 'No files to process';
      process.send?.({
        type: WORKER_STATUS.COMPLETED,
        message,
      });
      return;
    }

    console.log(`Starting to process ${files.length} files...`);
    await processFiles(files);
    console.log('All files processed successfully');

    process.send?.({
      type: WORKER_STATUS.COMPLETED,
      message: 'Embedding complete',
    });
    console.log('Embedding process completed');
  } catch (error) {
    const errorMessage = `Error: ${(error as Error).message}`;
    console.error('Embedding process failed:', errorMessage);
    process.send?.({
      type: WORKER_STATUS.ERROR,
      message: errorMessage,
    });
  }
}

// Listen for messages from the parent process
process.on('message', (data: WorkerData) => {
  // Extract data from the message
  codebaseDirPath = data.codebaseDirPath;
  embeddingDirPath = data.embeddingDirPath;
  config = data.config;
  resume = data.resume;

  // Enhanced logging with clear formatting
  console.log('==========================================');
  console.log('Embedding worker started with configuration:');
  console.log('- Codebase directory:', codebaseDirPath);
  console.log('- Embedding directory:', embeddingDirPath);
  console.log('- Dimensions:', config.dimensions);
  console.log('- Resume mode:', resume);
  console.log('==========================================');

  // Start processing
  processEmbeddings();
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('Embedding worker received SIGTERM signal');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Embedding worker received SIGINT signal');
  process.exit(0);
});

// If this script is run directly (not forked), exit
if (!process.send) {
  console.error('This script is meant to be run as a child process');
  process.exit(1);
}
