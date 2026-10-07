import { spawn } from 'child_process';
import * as vscode from 'vscode';

/** The WorkspaceGPT extension's Chrome Web Store page. Fixed here, never taken from the webview. */
const CHROME_EXTENSION_URL = 'https://chromewebstore.google.com/detail/gagogpeepmgaljpabdlpbcknjnbcaole';

function launch(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Open the extension's Web Store page in Google Chrome itself, not the default
 * browser (which may be Safari or Edge, where the extension cannot run). Chrome
 * installs an extension only when the user clicks "Add to Chrome" there; no
 * program can do it silently. Falls back to the default browser when Chrome
 * cannot be launched, and reports whether Chrome was the one opened.
 */
export async function openChromeExtensionInstall(): Promise<{ inChrome: boolean }> {
  let opened = false;
  if (process.platform === 'darwin') opened = await launch('open', ['-a', 'Google Chrome', CHROME_EXTENSION_URL]);
  else if (process.platform === 'win32') opened = await launch('cmd', ['/c', 'start', '', 'chrome', CHROME_EXTENSION_URL]);
  else opened = (await launch('google-chrome', [CHROME_EXTENSION_URL])) || (await launch('chromium', [CHROME_EXTENSION_URL]));
  if (opened) return { inChrome: true };
  await vscode.env.openExternal(vscode.Uri.parse(CHROME_EXTENSION_URL));
  return { inChrome: false };
}
