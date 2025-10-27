const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');
const isProduction = process.env.NODE_ENV === 'production';

// Recursively get all .ts files from a directory
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

const workerFiles = getAllFiles(path.join(__dirname, 'src/workers'));

// Utility function to copy directories recursively
async function copyRecursive(src, dest) {
  try {
    const stats = await fs.promises.stat(src);

    if (stats.isDirectory()) {
      await fs.promises.mkdir(dest, { recursive: true });
      const files = await fs.promises.readdir(src);

      await Promise.all(files.map(file =>
        copyRecursive(path.join(src, file), path.join(dest, file))
      ));
    } else {
      // Ensure destination directory exists
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
    }
  } catch (error) {
    console.warn(`Warning: Could not copy ${src} to ${dest}:`, error.message);
  }
}

/** Main extension: CommonJS for VSCode compatibility */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  format: 'cjs',
  sourcemap: true,
  minify: isProduction,
  external: [
    'vscode',
    '@xenova/transformers',  // Keep external - don't bundle
    'onnxruntime-node',      // Required by @xenova/transformers for Node.js backend
    'sharp'                  // Image processing (if used)
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
  keepNames: true,
};

/** Worker processes: ESM for @xenova/transformers support */
const workersConfig = {
  entryPoints: workerFiles,
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist/workers',
  outbase: 'src/workers',
  format: 'esm',
  sourcemap: true,
  minify: isProduction,
  external: [
    'vscode',
    'onnxruntime-node',
    'sharp',
    '@xenova/transformers'  // Keep external - don't bundle
  ],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
  keepNames: true,
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`
  }
};

// Copy dependencies and their nested dependencies recursively
async function copyDependencyWithNested(depName, srcNodeModules, destNodeModules, visited = new Set(), excludedDependencies = new Set()) {
  if (visited.has(depName) || excludedDependencies.has(depName)) {
    return; // Avoid circular dependencies or excluded dependencies
  }
  visited.add(depName);

  const srcPath = path.join(srcNodeModules, depName);
  const destPath = path.join(destNodeModules, depName);

  if (!fs.existsSync(srcPath)) {
    console.warn(`⚠️  Dependency ${depName} not found in ${srcNodeModules}`);
    return;
  }

  // Copy the main dependency
  await copyRecursive(srcPath, destPath);
  console.log(`✅ Copied ${depName}`);

  // Check for package.json to find nested dependencies
  const packageJsonPath = path.join(srcPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.optionalDependencies
      };

      // Copy nested dependencies
      for (const nestedDep of Object.keys(allDeps || {})) {
        await copyDependencyWithNested(nestedDep, srcNodeModules, destNodeModules, visited, excludedDependencies);
      }
    } catch (error) {
      console.warn(`⚠️  Could not read package.json for ${depName}:`, error.message);
    }
  }
}

// Copy pre-downloaded models to output directory
async function copyModels() {
  console.log('📦 Copying pre-downloaded models...');

  const srcModelsDir = path.join(__dirname, 'models');
  const outModelsDir = path.join(__dirname, 'dist', 'models');

  // Check if models directory exists
  if (!fs.existsSync(srcModelsDir)) {
    console.warn('⚠️  Models directory not found. Run "pnpm run download-models" first.');
    return;
  }

  // Copy models directory
  await copyRecursive(srcModelsDir, outModelsDir);
  console.log('✅ Models copied successfully');
}

// Copy essential dependencies to output directory
async function copyDependencies() {
  console.log('📦 Copying dependencies...');

  const outNodeModules = path.join('dist', 'node_modules');
  const srcNodeModules = 'node_modules';

  // Clean existing node_modules in output
  if (fs.existsSync(outNodeModules)) {
    await fs.promises.rm(outNodeModules, { recursive: true, force: true });
  }

  // Main dependencies to copy (with all their nested dependencies)
  const mainDependencies = [
    '@xenova/transformers'
  ];

  // Dependencies to exclude (problematic ones)
  const excludedDependencies = new Set([
    'sharp',  // Image processing - not needed for text embeddings
    'detect-libc',
    'color',
    'semver',
    // Exclude platform-specific sharp dependencies
    '@img/sharp-darwin-arm64',
    '@img/sharp-darwin-x64',
    '@img/sharp-libvips-darwin-arm64',
    '@img/sharp-libvips-darwin-x64',
    '@img/sharp-linux-arm',
    '@img/sharp-linux-arm64',
    '@img/sharp-linux-x64',
    '@img/sharp-win32-x64'
  ]);

  for (const dep of mainDependencies) {
    await copyDependencyWithNested(dep, srcNodeModules, outNodeModules, new Set(), excludedDependencies);
  }

  console.log('✅ Dependencies copied successfully');
}

// Ensure dist/workers/package.json exists for ESM support
async function ensureWorkersPackageJson() {
  const workersDistDir = path.join(__dirname, 'dist', 'workers');
  const packageJsonPath = path.join(workersDistDir, 'package.json');
  if (!fs.existsSync(workersDistDir)) {
    fs.mkdirSync(workersDistDir, { recursive: true });
  }
  const workersPackageJson = { type: 'module' };
  fs.writeFileSync(packageJsonPath, JSON.stringify(workersPackageJson, null, 2));
}

// Main build function
async function build() {
  try {
    console.log('🔨 Building extension...');

    // Clean output directory
    if (fs.existsSync('dist')) {
      await fs.promises.rm('dist', { recursive: true, force: true });
    }

    await ensureWorkersPackageJson();

    // Build with esbuild
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(workersConfig)
    ]);
    console.log('✅ ESBuild completed');

    // Copy dependencies and models
    await copyDependencies();
    await copyModels();

    console.log('🎉 Build completed successfully');
  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

// Watch mode
async function watch() {
  try {
    console.log('👀 Setting up watch mode...');

    // Initial build
    await build();

    // Setup watcher
    const [extensionContext, workersContext] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(workersConfig)
    ]);
    await Promise.all([
      extensionContext.watch(),
      workersContext.watch()
    ]);

    console.log('👀 Watching for changes...');

    // Note: In watch mode, dependencies are only copied on initial build
    // If you modify dependencies, restart the watch process

  } catch (error) {
    console.error('❌ Watch setup failed:', error);
    process.exit(1);
  }
}

// Run build or watch based on arguments
if (isWatch) {
  watch();
} else {
  build();
}