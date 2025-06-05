const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

// Function to get all files from a directory recursively
function getAllFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      fileList = getAllFiles(filePath, fileList);
    } else if (file.endsWith('.ts')) {
      fileList.push(filePath);
    }
  });
  return fileList;
}

// Get all worker files
const workerFiles = getAllFiles(path.join(__dirname, 'src/workers'));

/** @type {import('esbuild').BuildOptions} */
const baseConfig = {
  entryPoints: [
    'src/extension.ts',
    ...workerFiles
  ],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  format: 'cjs',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  external: ['vscode'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
};

if (isWatch) {
  esbuild.context(baseConfig).then(context => {
    context.watch();
  });
} else {
  esbuild.build(baseConfig).catch(() => process.exit(1));
} 