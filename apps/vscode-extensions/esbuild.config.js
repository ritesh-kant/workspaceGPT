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

// Utility function to copy directories recursively.
// `shouldSkip(src)` is checked before every file/directory so unwanted
// subtrees (wrong-platform binaries, vendor wasm/maps) are never even read.
async function copyRecursive(src, dest, shouldSkip) {
  if (shouldSkip && shouldSkip(src)) {
    return;
  }
  try {
    const stats = await fs.promises.stat(src);

    if (stats.isDirectory()) {
      await fs.promises.mkdir(dest, { recursive: true });
      const files = await fs.promises.readdir(src);

      await Promise.all(files.map(file =>
        copyRecursive(path.join(src, file), path.join(dest, file), shouldSkip)
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

// vsce/ovsx target name -> onnxruntime-node's bin/napi-v3/<platform>/<arch> folder.
const ONNXRUNTIME_NODE_TARGET_PLATFORMS = {
  'win32-x64': ['win32', 'x64'],
  'win32-arm64': ['win32', 'arm64'],
  'linux-x64': ['linux', 'x64'],
  'linux-arm64': ['linux', 'arm64'],
  'darwin-x64': ['darwin', 'x64'],
  'darwin-arm64': ['darwin', 'arm64'],
};

// @vscode/ripgrep ships each platform's binary as its own npm package, named
// to exactly match a vsce/ovsx --target string — no folder-structure mapping
// needed like onnxruntime-node above, just the package name.
const RIPGREP_PLATFORM_PACKAGES = [
  'darwin-x64', 'darwin-arm64',
  'win32-x64', 'win32-arm64', 'win32-ia32',
  'linux-x64', 'linux-arm64', 'linux-arm', 'linux-ppc64', 'linux-riscv64', 'linux-s390x', 'linux-ia32',
].map((p) => `@vscode/ripgrep-${p}`);

// Builds the shouldSkip predicate used while copying @xenova/transformers and
// its nested deps into dist/node_modules.
//
// Always skipped: onnxruntime-web's/transformers' vendored *.wasm and *.map
// files. transformers.js statically imports both onnxruntime-node and
// onnxruntime-web (see its backends/onnx.js), but in this extension every
// embedding call runs inside a Node worker_threads/child_process worker, so
// the code path that actually executes the wasm backend never runs — only
// onnxruntime-node's native binding does. The web package's JS entry point
// must stay (removing the package breaks the static import), but its wasm
// payload is dead weight.
//
// Conditionally skipped (only when VSCODE_TARGET is set): onnxruntime-node's
// native binaries for every platform/arch except the one being packaged.
// vsce/ovsx --target only tags the manifest; excluding the other 5 platform
// binaries is left to the build, which is what this does.
function createDependencyFilter() {
  const target = process.env.VSCODE_TARGET;
  let targetPlatform = null;
  if (target) {
    targetPlatform = ONNXRUNTIME_NODE_TARGET_PLATFORMS[target];
    if (!targetPlatform) {
      throw new Error(`Unknown VSCODE_TARGET "${target}". Valid targets: ${Object.keys(ONNXRUNTIME_NODE_TARGET_PLATFORMS).join(', ')}`);
    }
  }

  return function shouldSkip(srcPath) {
    if (srcPath.endsWith('.wasm') || srcPath.endsWith('.map')) {
      return true;
    }

    if (targetPlatform) {
      const segments = srcPath.split(path.sep);
      const napiIdx = segments.lastIndexOf('napi-v3');
      if (napiIdx !== -1 && segments[napiIdx - 1] === 'bin') {
        const [platform, arch] = segments.slice(napiIdx + 1, napiIdx + 3);
        if (platform && platform !== targetPlatform[0]) {
          return true;
        }
        if (platform === targetPlatform[0] && arch && arch !== targetPlatform[1]) {
          return true;
        }
      }
    }

    return false;
  };
}

/** Main extension: CommonJS for VSCode compatibility */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  format: 'cjs',
  sourcemap: !isProduction,
  minify: isProduction,
  external: [
    'vscode',
    '@xenova/transformers',  // Keep external - don't bundle
    'onnxruntime-node',      // Required by @xenova/transformers for Node.js backend
    'sharp',                 // Image processing (if used)
    '@vscode/ripgrep'        // ESM + native binary resolution — must stay external
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
  sourcemap: !isProduction,
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

// pnpm's non-flat store resolves a package's own dependencies through a
// per-package symlinked view, not by hoisting them into the top-level
// node_modules — hand-rolling that directory math (../.. vs ../node_modules,
// scoped vs unscoped, etc.) is fragile and store-layout-specific. Node's own
// resolver already walks that structure correctly, so ask it directly.
function resolveNestedDepDir(depName, fromDir) {
  try {
    // `paths` walks up from a REAL directory (Module._nodeModulePaths does not
    // resolve symlinks itself) — pnpm's per-package view lives behind a
    // symlink, so an unresolved fromDir silently fails to find anything nested.
    const realFromDir = fs.realpathSync(fromDir);
    const pkgJsonPath = require.resolve(`${depName}/package.json`, { paths: [realFromDir] });
    return path.dirname(pkgJsonPath);
  } catch {
    return null;
  }
}

// Copy dependencies and their nested dependencies recursively.
async function copyDependencyWithNested(depName, srcNodeModules, destNodeModules, visited = new Set(), excludedDependencies = new Set(), shouldSkip, parentSrcPath) {
  if (visited.has(depName) || excludedDependencies.has(depName)) {
    return; // Avoid circular dependencies or excluded dependencies
  }
  visited.add(depName);

  const topLevelSrcPath = path.join(srcNodeModules, depName);
  const srcPath = fs.existsSync(topLevelSrcPath)
    ? topLevelSrcPath
    : (parentSrcPath ? resolveNestedDepDir(depName, parentSrcPath) : null);
  const destPath = path.join(destNodeModules, depName);

  if (!srcPath) {
    console.warn(`⚠️  Dependency ${depName} not found in ${srcNodeModules}${parentSrcPath ? ` (or resolvable from ${parentSrcPath})` : ''}`);
    return;
  }

  // Copy the main dependency
  await copyRecursive(srcPath, destPath, shouldSkip);
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
        await copyDependencyWithNested(nestedDep, srcNodeModules, destNodeModules, visited, excludedDependencies, shouldSkip, srcPath);
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
    '@xenova/transformers',
    // Pulls in whichever @vscode/ripgrep-<platform>-<arch> optional dependency
    // is actually installed locally (pnpm only installs the one matching the
    // build machine). codebaseTools.ts resolves it lazily and falls back to a
    // pure-JS scanner if it's missing — e.g. a VSIX packaged for another
    // platform without that platform's optional dep installed at build time.
    '@vscode/ripgrep'
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

  const shouldSkip = createDependencyFilter();
  if (process.env.VSCODE_TARGET) {
    console.log(`🎯 Filtering onnxruntime-node native binaries for target: ${process.env.VSCODE_TARGET}`);

    // Only the matching platform's ripgrep binary belongs in this target's
    // VSIX — exclude the other 11 (all installed locally via pnpm's
    // supportedArchitectures so every target build has one available).
    const matchingRipgrepPackage = `@vscode/ripgrep-${process.env.VSCODE_TARGET}`;
    for (const pkg of RIPGREP_PLATFORM_PACKAGES) {
      if (pkg !== matchingRipgrepPackage) {
        excludedDependencies.add(pkg);
      }
    }
    console.log(`🎯 Filtering ripgrep binary for target: ${process.env.VSCODE_TARGET} (${matchingRipgrepPackage})`);
  }

  for (const dep of mainDependencies) {
    await copyDependencyWithNested(dep, srcNodeModules, outNodeModules, new Set(), excludedDependencies, shouldSkip);
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

// Copy the MCP server bundled output
async function copyMcpServer() {
  console.log('📦 Copying MCP Server bundle...');
  const mcpSrcPath = path.join(__dirname, '../workspacegpt-mcp/dist/index.js');
  const mcpDestPath = path.join(__dirname, 'dist', 'mcp-server.js');
  
  if (!fs.existsSync(mcpSrcPath)) {
    console.warn(`⚠️  MCP Server output not found at ${mcpSrcPath}. Please build @workspace-gpt/mcp-server first.`);
    return;
  }
  
  await fs.promises.mkdir(path.dirname(mcpDestPath), { recursive: true });
  await fs.promises.copyFile(mcpSrcPath, mcpDestPath);
  console.log('✅ MCP Server copied successfully');
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
    await copyMcpServer();

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