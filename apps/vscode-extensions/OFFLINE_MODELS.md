# Offline Embedding Model Setup

This extension now includes pre-bundled embedding models for complete offline functionality.

## Overview

The embedding model `Xenova/all-MiniLM-L6-v2` is pre-downloaded during the build process and bundled with the extension. This ensures:

- ✅ **Offline availability** - No internet connection required after installation
- ✅ **Faster startup** - No model download on first use
- ✅ **Privacy** - No external requests to HuggingFace during runtime
- ✅ **Reliability** - Works in restricted network environments

## Build Process

### 1. Download Models

Before building or publishing, run:

```bash
pnpm run download-models
```

This downloads the embedding model to `models/` directory (ignored by git).

### 2. Build Extension

```bash
pnpm run build
```

The build process:
1. Builds the TypeScript code with esbuild
2. Copies `models/` → `dist/models/`
3. Copies required dependencies to `dist/node_modules/`

### 3. Publish Extension

```bash
pnpm run vscode:prepublish
```

This automatically:
1. Downloads models (if not already present)
2. Builds the extension
3. Packages everything for publishing

## Architecture Changes

### File Structure

```
apps/vscode-extensions/
├── models/                          # Downloaded models (git-ignored)
│   └── models--Xenova--all-MiniLM-L6-v2/
├── dist/
│   ├── models/                      # Copied models (included in VSIX)
│   ├── node_modules/
│   │   └── @xenova/transformers/
│   └── workers/
├── scripts/
│   └── download-models.js           # Model download script
└── src/
    └── workers/
        └── utils/
            └── initializeEmbeddingModel.ts  # Uses local models
```

### Key Changes

1. **scripts/download-models.js**
   - Downloads model from HuggingFace
   - Stores in `models/` directory
   - Shows progress during download

2. **esbuild.config.js**
   - Added `copyModels()` function
   - Copies `models/` → `dist/models/` during build

3. **src/workers/utils/initializeEmbeddingModel.ts**
   - Changed `local_files_only: false` → `true`
   - Points to bundled models: `__dirname/../../models`
   - No runtime downloading

4. **package.json**
   - Added `download-models` script
   - Integrated into `vscode:prepublish`

5. **.vscodeignore**
   - Includes `!dist/models/**` for packaging

6. **.gitignore**
   - Excludes `models/` from version control

## Model Details

- **Model**: `Xenova/all-MiniLM-L6-v2`
- **Type**: Feature extraction (embeddings)
- **Dimensions**: 384
- **Quantized**: Yes (smaller size)
- **Size**: ~25 MB (approximate)

## Development Workflow

### First Time Setup

```bash
# Install dependencies
pnpm install

# Download models
pnpm run download-models

# Build extension
pnpm run build

# Test extension
code --extensionDevelopmentPath=.
```

### Subsequent Builds

```bash
# Models are already downloaded, just build
pnpm run build
```

### Publishing

```bash
# Automatically downloads models if needed + builds
pnpm run vscode:prepublish

# Then publish
pnpm run vscode:publish
```

## Troubleshooting

### Model not found error

If you see "Failed to initialize model" errors:

1. Ensure models are downloaded:
   ```bash
   pnpm run download-models
   ```

2. Rebuild the extension:
   ```bash
   pnpm run build
   ```

3. Check that `dist/models/` exists and contains model files

### Models directory size

The models directory adds ~25 MB to the extension size. This is acceptable for offline functionality.

### Updating the model

To use a different model:

1. Update `MODEL_NAME` in `scripts/download-models.js`
2. Update `DEFAULT_TEXT_EMBEDDING_MODEL` in `constants.ts`
3. Run `pnpm run download-models`
4. Rebuild the extension

## Performance

- **First load**: ~1-2 seconds (loading from disk)
- **Subsequent uses**: Instant (model cached in memory)
- **No network calls**: Complete offline operation

## Benefits Over Dynamic Download

| Aspect | Before (Dynamic) | After (Pre-bundled) |
|--------|------------------|---------------------|
| First use | 30-60s download | 1-2s load |
| Network required | Yes | No |
| Offline support | No | Yes |
| Extension size | ~5 MB | ~30 MB |
| Privacy | Downloads from HF | Fully local |
| Reliability | Network dependent | Always available |
