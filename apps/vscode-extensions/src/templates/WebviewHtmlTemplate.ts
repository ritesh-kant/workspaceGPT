import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class WebviewHtmlTemplate {
  constructor(private readonly extensionUri: vscode.Uri) {}

  public getHtml(webview: vscode.Webview, layout: 'sidebar' | 'editor' = 'sidebar'): string {
    try {
      const html = this.getReactHtml(webview, layout);
      if (!html) {
        throw new Error('React build not available');
      }
      return html;
    } catch (error) {
      console.error('Error loading webview HTML:', error);
      throw error;
    }
  }

  private getReactHtml(webview: vscode.Webview, layout: 'sidebar' | 'editor'): string | null {
    const reactDistPath = path.join(this.extensionUri.fsPath, 'webview', 'dist');
    
    if (!this.isReactBuildAvailable(reactDistPath)) {
      return null;
    }

    let indexHtml = fs.readFileSync(
      path.join(reactDistPath, 'index.html'),
      'utf8'
    );

    indexHtml = this.convertLocalPathsToWebviewUris(indexHtml, reactDistPath, webview);
    indexHtml = this.addContentSecurityPolicy(indexHtml, webview);
    indexHtml = this.injectChatLayout(indexHtml, layout);

    return indexHtml;
  }

  private isReactBuildAvailable(reactDistPath: string): boolean {
    return (
      fs.existsSync(reactDistPath) &&
      fs.existsSync(path.join(reactDistPath, 'index.html'))
    );
  }

  private convertLocalPathsToWebviewUris(
    html: string,
    reactDistPath: string,
    webview: vscode.Webview
  ): string {
    return html.replace(/(href|src)="([^"]+)"/g, (match, attr, value) => {
      if (value.startsWith('http') || value.startsWith('//')) {
        return match;
      }

      const localPath = path.join(reactDistPath, value);
      const webviewUri = webview.asWebviewUri(vscode.Uri.file(localPath));
      const cacheBuster = fs.existsSync(localPath) ? fs.statSync(localPath).mtimeMs : Date.now();
      return `${attr}="${webviewUri}?v=${cacheBuster}"`;
    });
  }

  private addContentSecurityPolicy(html: string, webview: vscode.Webview): string {
    if (!html.includes('<meta http-equiv="Content-Security-Policy"')) {
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; connect-src ${webview.cspSource} https:;">`;
      html = html.replace('</head>', `${csp}\n</head>`);
    }
    return html;
  }

  /**
   * The editor-tab webview is a separate iframe from the sidebar. Tag it so
   * the React app can skip the sidebar-collapse watch and show restore vs
   * maximize without waiting for a host message.
   */
  private injectChatLayout(html: string, layout: 'sidebar' | 'editor'): string {
    const tag = `<script>window.__WGPT_CHAT_LAYOUT__=${JSON.stringify(layout)};</script>`;
    if (/<body[^>]*>/i.test(html)) {
      return html.replace(/<body[^>]*>/i, (open) => `${open}${tag}`);
    }
    return tag + html;
  }
}