// Test function
function shouldExcludeFile(filePath, pattern) {
  // Normalize file path to use forward slashes
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // For patterns like '**/node_modules/**'
  if (pattern === '**/node_modules/**') {
    return normalizedPath.includes('/node_modules/');
  }
  
  // For patterns like '**/dist/**'
  if (pattern === '**/dist/**') {
    return normalizedPath.includes('/dist/');
  }
  
  // For patterns like '**/.git/**'
  if (pattern === '**/.git/**') {
    return normalizedPath.includes('/.git/');
  }
  
  // For patterns like '**/.venv/**'
  if (pattern === '**/.venv/**') {
    return normalizedPath.includes('/.venv/');
  }
  
  // For patterns like '**/venv/**'
  if (pattern === '**/venv/**') {
    return normalizedPath.includes('/venv/');
  }
  
  // For patterns like '**/build/**'
  if (pattern === '**/build/**') {
    return normalizedPath.includes('/build/');
  }
  
  // For patterns like '**/target/**'
  if (pattern === '**/target/**') {
    return normalizedPath.includes('/target/');
  }
  
  // For patterns like '**/.*/**'
  if (pattern === '**/.*/**') {
    return /\/\.[^\/]+\//.test(normalizedPath);
  }
  
  return false;
}

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
  '/Users/user/project/src/.gitkeep'
];

// Test patterns
const patterns = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/build/**',
  '**/target/**',
  '**/.*/**'
];

// Test each path against each pattern
testPaths.forEach(path => {
  console.log(`Path: ${path}`);
  patterns.forEach(pattern => {
    const shouldExclude = shouldExcludeFile(path, pattern);
    if (shouldExclude) {
      console.log(`  Excluded by: ${pattern}`);
    }
  });
  console.log('---');
});

// Test the combined pattern string
console.log("\nTesting combined pattern string:");
const combinedPattern = '**/node_modules/**,**/dist/**,**/.git/**,**/.venv/**,**/venv/**,**/build/**,**/target/**,**/.*/**';

function shouldExcludeFileCombined(filePath, patternString) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const patterns = patternString.split(',');
  
  return patterns.some(pattern => {
    pattern = pattern.trim();
    
    // For patterns like '**/node_modules/**'
    if (pattern === '**/node_modules/**') {
      return normalizedPath.includes('/node_modules/');
    }
    
    // For patterns like '**/dist/**'
    if (pattern === '**/dist/**') {
      return normalizedPath.includes('/dist/');
    }
    
    // For patterns like '**/.git/**'
    if (pattern === '**/.git/**') {
      return normalizedPath.includes('/.git/');
    }
    
    // For patterns like '**/.venv/**'
    if (pattern === '**/.venv/**') {
      return normalizedPath.includes('/.venv/');
    }
    
    // For patterns like '**/venv/**'
    if (pattern === '**/venv/**') {
      return normalizedPath.includes('/venv/');
    }
    
    // For patterns like '**/build/**'
    if (pattern === '**/build/**') {
      return normalizedPath.includes('/build/');
    }
    
    // For patterns like '**/target/**'
    if (pattern === '**/target/**') {
      return normalizedPath.includes('/target/');
    }
    
    // For patterns like '**/.*/**'
    if (pattern === '**/.*/**') {
      return /\/\.[^\/]+\//.test(normalizedPath);
    }
    
    return false;
  });
}

testPaths.forEach(path => {
  const shouldExclude = shouldExcludeFileCombined(path, combinedPattern);
  console.log(`Path: ${path}`);
  console.log(`Should exclude: ${shouldExclude}`);
  console.log('---');
});
