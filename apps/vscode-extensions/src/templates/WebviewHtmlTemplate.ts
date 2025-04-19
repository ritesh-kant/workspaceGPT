import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class WebviewHtmlTemplate {
  constructor(private readonly extensionUri: vscode.Uri) {}

  public getHtml(webview: vscode.Webview): string {
    try {
      const html = this.getReactHtml(webview);
      if (!html) {
        throw new Error('React build not available');
      }
      return html;
    } catch (error) {
      console.error('Error loading webview HTML:', error);
      throw error;
    }
  }

  private getReactHtml(webview: vscode.Webview): string | null {
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
      return `${attr}="${webviewUri}"`;
    });
  }

  private addContentSecurityPolicy(html: string, webview: vscode.Webview): string {
    if (!html.includes('<meta http-equiv="Content-Security-Policy"')) {
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https:; connect-src ${webview.cspSource} https:;">`;
      html = html.replace('</head>', `${csp}\n</head>`);
    }
    return html;
  }


}