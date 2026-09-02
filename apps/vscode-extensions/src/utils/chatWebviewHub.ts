import * as vscode from 'vscode';

/**
 * Fan-out target used by every host→webview `postMessage`. Handlers still
 * take a `WebviewView`-shaped object; this façade is that object, pointing at
 * whichever chat surface is currently active (sidebar view or editor panel)
 * so we never run two message handlers / ChatServices at once.
 */
export class ChatWebviewHub {
  private sidebar?: vscode.Webview;
  private editor?: vscode.Webview;

  /** The surface host replies should land on. */
  private active: 'sidebar' | 'editor' = 'sidebar';

  readonly facade = {
    webview: {
      postMessage: (message: unknown): Thenable<boolean> => this.postToActive(message),
    },
  } as unknown as vscode.WebviewView;

  setSidebar(webview: vscode.Webview | undefined): void {
    this.sidebar = webview;
    if (!webview && this.active === 'sidebar') {
      this.active = this.editor ? 'editor' : 'sidebar';
    }
  }

  setEditor(webview: vscode.Webview | undefined): void {
    this.editor = webview;
    if (!webview && this.active === 'editor') {
      this.active = this.sidebar ? 'sidebar' : 'editor';
    }
  }

  setActive(surface: 'sidebar' | 'editor'): void {
    this.active = surface;
  }

  getActive(): 'sidebar' | 'editor' {
    return this.active;
  }

  getSidebar(): vscode.Webview | undefined {
    return this.sidebar;
  }

  getEditor(): vscode.Webview | undefined {
    return this.editor;
  }

  hasSidebar(): boolean {
    return !!this.sidebar;
  }

  hasEditor(): boolean {
    return !!this.editor;
  }

  postToActive(message: unknown): Thenable<boolean> {
    const target = this.active === 'editor' ? this.editor : this.sidebar;
    return target?.postMessage(message) ?? Promise.resolve(false);
  }

  postTo(surface: 'sidebar' | 'editor', message: unknown): Thenable<boolean> {
    const target = surface === 'editor' ? this.editor : this.sidebar;
    return target?.postMessage(message) ?? Promise.resolve(false);
  }
}
