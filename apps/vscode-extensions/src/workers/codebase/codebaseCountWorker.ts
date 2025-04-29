import { workerData, parentPort } from 'worker_threads';
import { stat as fsStat } from 'fs/promises';
import { glob } from 'glob';
import * as path from 'path';

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