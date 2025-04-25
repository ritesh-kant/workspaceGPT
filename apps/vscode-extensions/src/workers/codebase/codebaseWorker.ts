import { workerData, parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { glob } from 'glob';
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

// Import constants
import { WORKER_STATUS } from '../../../constants';

// Define worker data interface
interface WorkerData {
  repoPath: string;
  includePatterns: string | string[]; // Can be a single pattern or array of patterns
  excludePatterns: string[];
  maxFileSizeKb: number;
  outputDirPath: string;
  resume: boolean;
  lastProcessedFilePath?: string;
  processedFiles?: ProcessedFile[];
}

// Define processed file interface
interface ProcessedFile {
  filename: string;
  text: string;
  filePath: string;
}

// Extract worker data
const {
  repoPath,
  includePatterns,
  excludePatterns,
  maxFileSizeKb,
  outputDirPath,
  resume,
  lastProcessedFilePath,
  processedFiles,
} = workerData as WorkerData;

// Function to check if a file should be excluded
function shouldExcludeFile(
  filePath: string,
  excludePatterns: string[]
): boolean {
  return excludePatterns.some((pattern) => {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(regexPattern);
    return regex.test(filePath);
  });
}
// Function to get all files matching the include patterns
async function getFiles(): Promise<string[]> {
  try {

    // Process each include pattern and combine results
    let allFiles: string[] = [];

    // Check if includePatterns is a string or an array
    // If it's a string, use it directly
    try {
      const files = await glob(includePatterns, {
        cwd: repoPath,
        absolute: true,
      });
      allFiles = [...files];
      console.log(
        `Found ${files.length} files for pattern: ${includePatterns}`
      );
    } catch (error) {
      console.error(
        `Error with pattern ${includePatterns}:`,
        (error as Error).message
      );
    }

    // Filter out excluded files and directories
    const filteredFiles: string[] = [];
    for (const file of allFiles) {
      // Skip if file matches exclude pattern
      if (shouldExcludeFile(file, excludePatterns)) {
        continue;
      }

      // Check if it's a file and not a directory
      const stats = await stat(file);
      if (!stats.isFile()) {
        continue;
      }

      // Check file size
      const fileSizeKb = stats.size / 1024;
      if (fileSizeKb > maxFileSizeKb) {
        continue;
      }

      filteredFiles.push(file);
    }

    return filteredFiles;
  } catch (error) {
    if (parentPort) {
      parentPort.postMessage({
        type: WORKER_STATUS.ERROR,
        message: `Error getting files: ${(error as Error).message}`,
      });
    }
    return [];
  }
}

// Function to process a file
async function processFile(filePath: string): Promise<ProcessedFile | null> {
  try {
    // Read file content
    const content = await readFile(filePath, 'utf8');

    // Create a processed file object
    const processedFile: ProcessedFile = {
      filename: path.basename(filePath),
      text: content,
      filePath: filePath,
    };

    // Send the processed file to the parent
    if (parentPort) {
      parentPort.postMessage({
        type: WORKER_STATUS.PROCESSED,
        file: processedFile,
      });
    }

    return processedFile;
  } catch (error) {
    if (parentPort) {
      parentPort.postMessage({
        type: WORKER_STATUS.ERROR,
        message: `Error processing file ${filePath}: ${(error as Error).message}`,
      });
    }
    return null;
  }
}

// Main function to process all files
async function processAllFiles(): Promise<void> {
  try {
    // Get all files
    const files = await getFiles();
    const totalFiles = files.length;

    if (totalFiles === 0) {
      if (parentPort) {
        parentPort.postMessage({
          type: WORKER_STATUS.COMPLETED,
          files: [],
        });
      }
      return;
    }

    // Determine starting index for resuming
    let startIndex = 0;
    if (resume && lastProcessedFilePath) {
      startIndex =
        files.findIndex((file) => file === lastProcessedFilePath) + 1;
      if (startIndex <= 0) {
        startIndex = 0;
      }
    }

    // Process files
    const processedFilesList: ProcessedFile[] = [];
    for (let i = startIndex; i < files.length; i++) {
      const filePath = files[i];

      // Process the file
      const processedFile = await processFile(filePath);
      if (processedFile) {
        processedFilesList.push(processedFile);
      }

      // Calculate progress
      const current = i + 1;
      const progress = Math.round((current / totalFiles) * 100);

      // Send progress update
      if (parentPort) {
        parentPort.postMessage({
          type: WORKER_STATUS.PROCESSING,
          progress,
          current,
          total: totalFiles,
          lastProcessedFilePath: filePath,
        });
      }
    }

    // Send completion message
    if (parentPort) {
      parentPort.postMessage({
        type: WORKER_STATUS.COMPLETED,
        files: processedFilesList,
      });
    }
  } catch (error) {
    if (parentPort) {
      parentPort.postMessage({
        type: WORKER_STATUS.ERROR,
        message: `Error processing files: ${(error as Error).message}`,
      });
    }
  }
}

// Start processing files
processAllFiles();
