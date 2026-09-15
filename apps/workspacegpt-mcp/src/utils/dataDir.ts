import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Resolves the WorkspaceGPT data directory where the VS Code extension
 * stores synced markdown files and embeddings.
 *
 * Priority:
 *  1. --data-dir CLI argument
 *  2. WORKSPACEGPT_DATA_DIR environment variable
 *  3. Auto-detect from common VS Code globalStorage locations
 */
export function resolveDataDir(args: string[]): string {
  // 1. CLI argument
  const dataDirIndex = args.indexOf('--data-dir');
  if (dataDirIndex !== -1 && args[dataDirIndex + 1]) {
    const dir = args[dataDirIndex + 1];
    validateDataDir(dir);
    return dir;
  }

  // 2. Environment variable
  const envDir = process.env.WORKSPACEGPT_DATA_DIR;
  if (envDir) {
    validateDataDir(envDir);
    return envDir;
  }

  // 3. Auto-detect
  const detected = autoDetectDataDir();
  if (detected) {
    return detected;
  }

  throw new Error(
    'Could not find WorkspaceGPT data directory.\n' +
    'Please ensure the WorkspaceGPT VS Code extension has synced data, then either:\n' +
    '  • Set WORKSPACEGPT_DATA_DIR environment variable\n' +
    '  • Pass --data-dir /path/to/data as a CLI argument\n\n' +
    'The data directory is typically located at:\n' +
    `  macOS:   ~/Library/Application Support/Code/User/globalStorage/riteshkant.workspacegpt-extension\n` +
    `  Linux:   ~/.config/Code/User/globalStorage/riteshkant.workspacegpt-extension\n` +
    `  Windows: %APPDATA%/Code/User/globalStorage/riteshkant.workspacegpt-extension`
  );
}

function autoDetectDataDir(): string | null {
  const extensionId = 'riteshkant.workspacegpt-extension';
  const home = os.homedir();
  const platform = os.platform();

  // Build list of candidate paths for various editors
  const editorStorageBases: string[] = [];

  if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    editorStorageBases.push(
      path.join(appSupport, 'Code', 'User', 'globalStorage'),           // VS Code
      path.join(appSupport, 'Code - Insiders', 'User', 'globalStorage'), // VS Code Insiders
      path.join(appSupport, 'Cursor', 'User', 'globalStorage'),          // Cursor
      path.join(appSupport, 'VSCodium', 'User', 'globalStorage'),        // VSCodium
    );
  } else if (platform === 'linux') {
    const configDir = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    editorStorageBases.push(
      path.join(configDir, 'Code', 'User', 'globalStorage'),
      path.join(configDir, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(configDir, 'Cursor', 'User', 'globalStorage'),
      path.join(configDir, 'VSCodium', 'User', 'globalStorage'),
    );
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    editorStorageBases.push(
      path.join(appData, 'Code', 'User', 'globalStorage'),
      path.join(appData, 'Code - Insiders', 'User', 'globalStorage'),
      path.join(appData, 'Cursor', 'User', 'globalStorage'),
      path.join(appData, 'VSCodium', 'User', 'globalStorage'),
    );
  }

  for (const base of editorStorageBases) {
    const candidate = path.join(base, extensionId);
    if (fs.existsSync(candidate)) {
      // Check that it contains at least one data subdirectory
      const hasAdo = fs.existsSync(path.join(candidate, 'ado'));
      const hasConfluence = fs.existsSync(path.join(candidate, 'confluence'));
      const hasJira = fs.existsSync(path.join(candidate, 'jira'));
      if (hasAdo || hasConfluence || hasJira) {
        return candidate;
      }
    }
  }

  return null;
}

function validateDataDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    throw new Error(`Data directory does not exist: ${dir}`);
  }

  const hasAdo = fs.existsSync(path.join(dir, 'ado'));
  const hasConfluence = fs.existsSync(path.join(dir, 'confluence'));
  const hasJira = fs.existsSync(path.join(dir, 'jira'));

  if (!hasAdo && !hasConfluence && !hasJira) {
    throw new Error(
      `Data directory exists but contains no synced data: ${dir}\n` +
      'Please sync Confluence, Azure DevOps, or Jira from the WorkspaceGPT VS Code extension first.'
    );
  }
}

function hasEmbeddings(embeddingDir: string): boolean {
  return (
    fs.existsSync(embeddingDir) &&
    (fs.existsSync(path.join(embeddingDir, 'embeddings.bin')) ||
     fs.existsSync(path.join(embeddingDir, 'index.json')))
  );
}

/**
 * Returns which data sources have been synced and have embeddings ready.
 */
export function getAvailableSources(dataDir: string): {
  confluence: boolean;
  ado: boolean;
  jira: boolean;
} {
  return {
    confluence: hasEmbeddings(path.join(dataDir, 'confluence', 'embeddings')),
    ado: hasEmbeddings(path.join(dataDir, 'ado', 'embeddings')),
    jira: hasEmbeddings(path.join(dataDir, 'jira', 'embeddings')),
  };
}
