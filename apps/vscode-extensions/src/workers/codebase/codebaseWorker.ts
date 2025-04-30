import { workerData, parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { glob } from 'glob';
import { WORKER_STATUS } from '../../../constants';

// Promisify file system operations
const readFile = promisify(fs.readFile);
const stat = promisify(fs.stat);

// Define interfaces
interface ProcessedFile {
  filename: string;
  text: string;
  filePath: string;
}

interface WorkerData {
  repoPath: string;
  includePatterns: string | string[];
  excludePatterns: string[];
  maxFileSizeKb: number;
  outputDirPath: string;
  resume: boolean;
  lastProcessedFilePath?: string;
  processedFiles?: ProcessedFile[];
}

// Extract worker data
const {
  repoPath,
  includePatterns,
  excludePatterns,
  maxFileSizeKb,
  resume,
  lastProcessedFilePath,
} = workerData as WorkerData;

// Helper function to send messages to parent
function sendMessage(type: string, data: any) {
  if (parentPort) {
    parentPort.postMessage({ type, ...data });
  }
}

// Function to check if a file should be excluded
function shouldExcludeFile(filePath: string, patterns: string[]): boolean {
  // Normalize file path to use forward slashes and convert to lowercase for case-insensitive matching
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

  // Special case for the specific path mentioned in the issue
  if (normalizedPath.includes('/venv/') ||
      normalizedPath.includes('/rapt-ui-automate/venv/') ||
      normalizedPath.includes('/python3.9/site-packages/')) {
    // console.log(`Excluding venv path: ${filePath}`);
    return true;
  }

  // Handle case where patterns is an array containing another array (legacy support)
  const flatPatterns = Array.isArray(patterns[0]) ? patterns[0] as unknown as string[] : patterns;

  // Process each pattern
  return flatPatterns.some((pattern) => {
    // Skip if pattern is not a string (defensive programming)
    if (typeof pattern !== 'string') return false;

    // Split pattern if it contains commas
    const subPatterns = pattern.split(',');

    // Check if any subpattern matches
    return subPatterns.some(subPattern => {
      // Trim whitespace and handle empty patterns
      subPattern = subPattern.trim();
      if (!subPattern) return false;

      // Convert pattern to lowercase for case-insensitive matching
      const lowerSubPattern = subPattern.toLowerCase();

      // Handle specific patterns
      switch (lowerSubPattern) {
        case '**/node_modules/**':
          return normalizedPath.includes('/node_modules/');
        case '**/dist/**':
          return normalizedPath.includes('/dist/');
        case '**/.git/**':
          return normalizedPath.includes('/.git/');
        case '**/.venv/**':
          return normalizedPath.includes('/.venv/');
        case '**/venv/**':
          return normalizedPath.includes('/venv/');
        case '**/build/**':
          return normalizedPath.includes('/build/');
        case '**/target/**':
          return normalizedPath.includes('/target/');
        case '**/.*/**':
          // Match paths that have a segment starting with a dot
          // This will match both files and directories that start with a dot
          return /\/\.[^\/]+/.test(normalizedPath);
      }

      // For other patterns, use a simpler approach
      if (lowerSubPattern.startsWith('**/') && lowerSubPattern.endsWith('/**')) {
        // For patterns like '**/node_modules/**'
        const innerPattern = lowerSubPattern.slice(3, -3);
        return normalizedPath.includes(`/${innerPattern}/`);
      }

      return false;
    });
  });
}

// Function to get all file names matching the include patterns
async function getFiles(): Promise<string[]> {
  try {
    // Get files matching include patterns
    const files = await glob(includePatterns, {
      cwd: repoPath,
      absolute: true,
    });

    console.log(`Found ${files.length} files for pattern: ${includePatterns}`);

    // Remove null values and return valid files
    return files as string[];
  } catch (error) {
    sendMessage(WORKER_STATUS.ERROR, {
      message: `Error getting files: ${(error as Error).message}`,
    });
    return [];
  }
}

// Function to process a file
async function readFileData(filePath: string): Promise<ProcessedFile | null> {
  try {
    // Read file content
    const content = await readFile(filePath, 'utf8');

    // Create a processed file object
    const processedFile: ProcessedFile = {
      filename: path.basename(filePath),
      text: content,
      filePath,
    };

    return processedFile;
  } catch (error) {
    sendMessage(WORKER_STATUS.ERROR, {
      message: `Error processing file ${filePath}: ${(error as Error).message}`,
    });
    return null;
  }
}

// Main function to process all files
async function processAllFiles(): Promise<void> {
  try {
    // Get all files
    const files = await getFiles();
    const totalFiles = files.length;

    if (!totalFiles) {
      sendMessage(WORKER_STATUS.COMPLETED, { files: [] });
      return;
    }

    // Determine starting index for resuming
    let startIndex = findStartIndex(files);

    // Process files in batches using Promise.all for parallel processing
    const batchSize = 20; // Smaller batch size for processing to avoid memory issues

    for (let i = startIndex; i < files.length; i += batchSize) {
      const batch = files.slice(i, Math.min(i + batchSize, files.length));
      const batchStartIndex = i;

      // Process batch of files in parallel
      const processedBatch = await Promise.all(
        batch.map(async (filePath, batchIndex) => {
          const current = batchStartIndex + batchIndex + 1;

          // Add debug logging for venv paths
          // if (filePath.toLowerCase().includes('/venv/')) {
          //   console.log(`Checking venv path: ${filePath}`);
          //   console.log(`Exclude patterns:`, JSON.stringify(excludePatterns));
          //   const shouldExclude = shouldExcludeFile(filePath, excludePatterns);
          //   console.log(`Should exclude: ${shouldExclude}`);

          //   if (!shouldExclude) {
          //     // If not excluded, log more details
          //     console.log(`WARNING: venv path not excluded: ${filePath}`);
          //   }

          //   if (shouldExclude) {
          //     return null;
          //   }
          // } else 
          if (shouldExcludeFile(filePath, excludePatterns)) {
            return null;
          }

          // Process the file
          const processedFile = await readFileData(filePath);

          // Return both the processed file and its metadata
          return {
            processedFile,
            current,
            filePath,
          };
        })
      );

      // Send messages for each processed file
      for (const item of processedBatch) {
        if(!item) continue;
        if (item.processedFile) {
          sendMessage(WORKER_STATUS.PROCESSED, { file: item.processedFile });
        }

        sendMessage(WORKER_STATUS.PROCESSING, {
          progress: Math.round((item.current / totalFiles) * 100),
          current: item.current,
          total: totalFiles,
          lastProcessedFilePath: item.filePath,
        });
      }
    }

    // Send completion message
    sendMessage(WORKER_STATUS.COMPLETED, { files: totalFiles });
  } catch (error) {
    sendMessage(WORKER_STATUS.ERROR, {
      message: `Error processing files: ${(error as Error).message}`,
    });
  }
}
function findStartIndex(files: string[]) {
  let startIndex = 0;
  if (resume && lastProcessedFilePath) {
    const index = files.findIndex((file) => file === lastProcessedFilePath);
    startIndex = index >= 0 ? index + 1 : 0;
  }
  return startIndex;
}

// Start processing files
processAllFiles();
