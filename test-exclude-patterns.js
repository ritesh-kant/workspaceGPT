// Test script for exclude patterns

// Function to check if a file should be excluded
function shouldExcludeFile(filePath, patterns) {
  // Normalize file path to use forward slashes
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // Process each pattern
  return patterns.some((pattern) => {
    // Split pattern if it contains commas
    const subPatterns = pattern.split(',');
    
    // Check if any subpattern matches
    return subPatterns.some(subPattern => {
      // Trim whitespace and handle empty patterns
      subPattern = subPattern.trim();
      if (!subPattern) return false;
      
      // Handle specific patterns
      switch (subPattern) {
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
          return /\/\.[^\/]+\//.test(normalizedPath);
      }
      
      // For other patterns, use a simpler approach
      if (subPattern.startsWith('**/') && subPattern.endsWith('/**')) {
        // For patterns like '**/node_modules/**'
        const innerPattern = subPattern.slice(3, -3);
        return normalizedPath.includes(`/${innerPattern}/`);
      }
      
      return false;
    });
  });
}

// Test patterns
const excludePatterns = ['**/node_modules/**,**/dist/**,**/.git/**,**/.venv/**,**/venv/**,**/build/**,**/target/**,**/.*/**'];

// Test paths
const testPaths = [
  '/Users/user/project/node_modules/package/file.js',
  '/Users/user/project/dist/bundle.js',
  '/Users/user/project/.git/HEAD',
  '/Users/user/project/.venv/bin/python',
  '/Users/user/project/venv/bin/python',
  '/Users/user/project/build/output.js',
  '/Users/user/project/target/classes/Main.class',
  '/Users/user/project/.hidden/file.txt',
  '/Users/user/project/src/main.js',
  '/Users/user/project/package.json',
  '/Users/user/project/node_modules',
  '/Users/user/project/.git',
  '/Users/user/project/src/.gitkeep',
  '/Users/user/project/src/components/node_modules/package/file.js',
];

// Test each path
testPaths.forEach(path => {
  const shouldExclude = shouldExcludeFile(path, excludePatterns);
  console.log(`Path: ${path}`);
  console.log(`Should exclude: ${shouldExclude}`);
  console.log('---');
});
