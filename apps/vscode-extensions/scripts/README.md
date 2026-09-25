# Scripts Directory

This directory contains utility scripts for the WorkspaceGPT extension.

## download-models.mjs

Downloads the embedding models listed in `MODELS` (keep in sync with `MODEL.DEFAULT_*` in `constants.ts`) from HuggingFace into `models/`, so the extension ships them and never downloads at runtime. The one in use is `Xenova/all-MiniLM-L6-v2` (384-dim, quantized, ~25 MB), which embeds Confluence pages, Jira issues and ADO work items.

Why bundle: indexing works offline and in locked-down networks, the first use doesn't wait on a download, and nothing reaches HuggingFace from a user's machine. `src/workers/utils/initializeEmbeddingModel.ts` loads from the bundled `models/` with `local_files_only: true`.

### Usage

```bash
pnpm run download-models
```

This script is automatically run during:
- `vscode:prepublish` - Before publishing the extension
- You can also run it manually to pre-download models for development

### What it does

1. Creates a `models/` directory in the extension root
2. Downloads the quantized version of the embedding model
3. Stores all model files (config, tokenizer, ONNX model) locally
4. Shows progress and file sizes during download

### Output

The downloaded model will be placed in:
```
apps/vscode-extensions/models/
└── models--Xenova--all-MiniLM-L6-v2/
    └── [model files]
```

This directory is:
- Excluded from git (via `.gitignore`)
- Copied to `dist/models/` during build (via `esbuild.config.js`)
- Included in the packaged extension (via `.vscodeignore`)

### If the model isn't found

"Failed to initialize model" means `dist/models/` is empty: run `pnpm run download-models`, then `pnpm run build`.

### Changing the model

Update `MODELS` here and `DEFAULT_TEXT_EMBEDDING_MODEL` in `constants.ts`, download, rebuild. Existing indexes are tied to the old model and must be re-synced.

## publish-targets.mjs

Packages (and optionally publishes) one VSIX per platform/arch instead of a universal one, so each carries only its own onnxruntime-node binary. It sets `VSCODE_TARGET`, which `esbuild.config.js` uses to prune the other platforms.

```bash
node scripts/publish-targets.mjs [--pre-release] [--package-only]
```

## post-install/patch-xenova-transformer.js

Patches the `@xenova/transformers` package to ensure compatibility with VS Code extension environment.

This runs automatically after `npm install` or `pnpm install`.
