import * as vscode from 'vscode';
import * as fs from 'fs';
import { spawn } from 'child_process';

export type OpenTarget = 'vscode' | 'cursor' | 'finder';

/** Command + args that open `folder` in each target, per platform. */
function commandFor(target: OpenTarget, folder: string): { cmd: string; args: string[] } {
  if (process.platform === 'darwin') {
    if (target === 'finder') return { cmd: 'open', args: [folder] };
    return { cmd: 'open', args: ['-a', target === 'cursor' ? 'Cursor' : 'Visual Studio Code', folder] };
  }
  if (target === 'finder') {
    return process.platform === 'win32'
      ? { cmd: 'explorer', args: [folder] }
      : { cmd: 'xdg-open', args: [folder] };
  }
  return { cmd: target === 'cursor' ? 'cursor' : 'code', args: [folder] };
}

export async function openFolderIn(target: unknown, folder: string): Promise<void> {
  if (target !== 'vscode' && target !== 'cursor' && target !== 'finder') return;
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    void vscode.window.showWarningMessage(`The folder ${folder} no longer exists.`);
    return;
  }
  const { cmd, args } = commandFor(target, folder);
  const label = target === 'finder' ? 'the file manager' : target === 'cursor' ? 'Cursor' : 'VS Code';
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
    child.on('error', () => void vscode.window.showWarningMessage(`Couldn't open ${label}.`));
    // `open -a` exits non-zero when the app isn't installed.
    child.on('exit', (code) => {
      if (code) void vscode.window.showWarningMessage(`Couldn't open ${label}.`);
    });
    child.unref();
  } catch {
    void vscode.window.showWarningMessage(`Couldn't open ${label}.`);
  }
}
