import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class WebviewHtmlTemplate {
  constructor(private readonly extensionUri: vscode.Uri) {}

  public getHtml(webview: vscode.Webview): string {
    try {
      return this.getReactHtml(webview) || this.getFallbackHtml();
    } catch (error) {
      console.error('Error loading webview HTML:', error);
      return this.getFallbackHtml();
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

  private getFallbackHtml(): string {
    return ` <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WorkspaceGPT Chat</title>
                <style>
                    body {
                        padding: 4px;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                    }
                    #chat-container {
                        display: flex;
                        flex-direction: column;
                        height: calc(100vh - 20px);
                    }
                    #messages {
                        flex-grow: 1;
                        overflow-y: auto;
                        margin-bottom: 10px;
                        padding: 10px;
                        background: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                    }
                    .message {
                        margin-bottom: 10px;
                        padding: 8px;
                        border-radius: 4px;
                    }
                    .user-message {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                    }
                    .bot-message {
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-input-border);
                    }
                    #input-container {
                        display: flex;
                        gap: 10px;
                    }
                    #message-input {
                        flex-grow: 1;
                        padding: 8px;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                    }
                    #send-button {
                        padding: 8px 16px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    #send-button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .loading {
                        display: none;
                        margin: 10px 0;
                        color: var(--vscode-descriptionForeground);
                    }
                </style>
            </head>
            <body>
                <div id="chat-container">
                    <div id="messages"></div>
                    <div class="loading">html Processing...</div>
                    <div id="input-container">
                        <input type="text" id="message-input" placeholder="Type your message...">
                        <button id="send-button">Send</button>
                    </div>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const messagesContainer = document.getElementById('messages');
                    const messageInput = document.getElementById('message-input');
                    const sendButton = document.getElementById('send-button');
                    const loadingIndicator = document.querySelector('.loading');

                    function appendMessage(content, isUser) {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = "message " + (isUser ? 'user-message' : 'bot-message');
                        messageDiv.textContent = content;
                        messagesContainer.appendChild(messageDiv);
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }

                    function sendMessage() {
                        const message = messageInput.value.trim();
                        if (message) {
                            appendMessage(message, true);
                            loadingIndicator.style.display = 'block';
                            vscode.postMessage({
                                type: 'sendMessage',
                                message: message
                            });
                            messageInput.value = '';
                        }
                    }

                    sendButton.addEventListener('click', sendMessage);
                    messageInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            sendMessage();
                        }
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        loadingIndicator.style.display = 'none';
                        switch (message.type) {
                            case 'response':
                                appendMessage(message.message, false);
                                break;
                            case 'error':
                                appendMessage("Error: " + message.message, false);
                                break;
                        }
                    });
                </script>
            </body>
            </html>`;
  }
}