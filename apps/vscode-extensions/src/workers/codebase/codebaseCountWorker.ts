import { workerData, parentPort } from 'worker_threads';
import { stat as fsStat } from 'fs/promises';
import { glob } from 'glob';

// Define worker data interface
interface WorkerData {
  repoPath: string;
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSizeKb: number;
}

// Extract worker data
const {
  repoPath,
  includePatterns,
  excludePatterns,
  maxFileSizeKb
} = workerData as WorkerData;

// Function to check if a file should be excluded
function shouldExcludeFile(filePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some(pattern => {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(regexPattern);
    return regex.test(filePath);
  });
}

// Function to count all files matching the include patterns
async function countFiles(): Promise<void> {
  try {
    let allFiles: string[] = [];
    
    // Process each include pattern
    for (const pattern of includePatterns) {
      const files = await glob(pattern, { cwd: repoPath, absolute: true });
      allFiles = [...allFiles, ...files];
    }
    
    // Filter out excluded files and directories
    let validFileCount = 0;
    for (const file of allFiles) {
      // Skip if file matches exclude pattern
      if (shouldExcludeFile(file, excludePatterns)) {
        continue;
      }
      
      // Check if it's a file and not a directory
      const stats = await fsStat(file);
      if (!stats.isFile()) {
        continue;
      }
      
      // Check file size
      const fileSizeKb = stats.size / 1024;
      if (fileSizeKb > maxFileSizeKb) {
        continue;
      }
      
      validFileCount++;
    }
    
    // Send the count back to the parent
    if (parentPort) {
      parentPort.postMessage(validFileCount);
    }
  } catch (error) {
    // Send error to parent
    console.error('Error counting files:', error);
    if (parentPort) {
      parentPort.postMessage(0); // Return 0 on error
    }
  }
}

// Start counting files
countFiles();