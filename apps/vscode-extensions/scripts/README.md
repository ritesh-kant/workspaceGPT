# Scripts Directory

This directory contains utility scripts for the WorkspaceGPT extension.

## download-models.mjs

Downloads the embedding model (`Xenova/all-MiniLM-L6-v2`) from HuggingFace and stores it locally in the `models/` directory for offline usage.

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

## post-install/patch-xenova-transformer.js

Patches the `@xenova/transformers` package to ensure compatibility with VS Code extension environment.

This runs automatically after `npm install` or `pnpm install`.
