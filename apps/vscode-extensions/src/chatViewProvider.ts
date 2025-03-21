import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        // Set the webview's HTML content
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the WebView
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'syncGlobalState':
                    // Save to VSCode's global state storage
                    await this._context.globalState.update('workspaceGPT-settings', data.state);
                    break;

                case 'clearGlobalState':
                    // Clear from VSCode's global state storage
                    await this._context.globalState.update('workspaceGPT-settings', undefined);
                    break;
                case 'getConfluenceConfig':
                    // Send current configuration to webview
                    const config = vscode.workspace.getConfiguration('workspaceGPT.confluence');
                    webviewView.webview.postMessage({
                        type: 'confluenceConfig',
                        config: {
                            baseUrl: config.get('baseUrl') || '',
                            spaceKey: config.get('spaceKey') || '',
                            userEmail: config.get('userEmail') || '',
                            apiToken: config.get('apiToken') || ''
                        }
                    });
                    break;

                case 'saveConfluenceConfig':
                    // Save configuration
                    await vscode.workspace.getConfiguration('workspaceGPT.confluence').update('baseUrl', data.config.baseUrl, true);
                    await vscode.workspace.getConfiguration('workspaceGPT.confluence').update('spaceKey', data.config.spaceKey, true);
                    await vscode.workspace.getConfiguration('workspaceGPT.confluence').update('userEmail', data.config.userEmail, true);
                    await vscode.workspace.getConfiguration('workspaceGPT.confluence').update('apiToken', data.config.apiToken, true);
                    break;

                case 'checkConfluenceConnection':
                    try {
                        // Here you would implement the actual connection check
                        // For now, we'll simulate a successful connection
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        webviewView.webview.postMessage({
                            type: 'confluenceConnectionStatus',
                            status: true,
                            message: 'Successfully connected to Confluence'
                        });
                    } catch (error) {
                        webviewView.webview.postMessage({
                            type: 'confluenceConnectionStatus',
                            status: false,
                            message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`
                        });
                    }
                    break;

                case 'startConfluenceSync':
                    try {
                        // Here you would implement the actual sync process
                        // For now, we'll simulate progress updates
                        for (let i = 0; i <= 100; i += 10) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                            webviewView.webview.postMessage({
                                type: 'syncProgress',
                                source: 'confluence',
                                progress: i
                            });
                        }
                        webviewView.webview.postMessage({
                            type: 'syncComplete',
                            source: 'confluence',

                        });
                    } catch (error) {
                        webviewView.webview.postMessage({
                            type: 'syncError',
                            message: error instanceof Error ? error.message : String(error)
                        });
                    }
                    break;

                case 'newChat':
                    try {
                        const config = vscode.workspace.getConfiguration('workspaceGPT');
                        const apiBaseUrl = config.get<string>('apiBaseUrl');
                        
                        const response = await fetch(`${apiBaseUrl}/v1/chat/completions/new_chat`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            }
                        });

                        if (!response.ok) {
                            throw new Error(`Failed to start new chat: ${response.status}`);
                        }

                        webviewView.webview.postMessage({
                            type: 'newChatCreated'
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error starting new chat: ${error instanceof Error ? error.message : String(error)}`);
                        webviewView.webview.postMessage({
                            type: 'error',
                            message: error instanceof Error ? error.message : String(error)
                        }); 
                    }
                    break;
                case 'sendMessage':
                    try {
                        const config = vscode.workspace.getConfiguration('workspaceGPT');
                        const apiBaseUrl = config.get<string>('apiBaseUrl');
                        const authToken = config.get<string>('authToken');
                        
                        // Use the actual message from the input
                        const requestPayload = {
                            question: data.message,
                            stream: false
                        };
                        
                        console.log("Sending request payload:", JSON.stringify(requestPayload));
                        
                        const response = await fetch(`${apiBaseUrl}/v1/chat/completions`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(requestPayload)
                        });

                        if (!response.ok) {
                            const errorText = await response.text();
                            console.error(`API request failed: ${response.status} ${response.statusText}`, errorText);
                            throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
                        }

                        const result = await response.json() as {answer: string};
                        console.log("API response:", JSON.stringify(result));
                        
                        webviewView.webview.postMessage({
                            type: 'response',
                            message: result.answer || "No answer received"
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : String(error)}`);
                        webviewView.webview.postMessage({
                            type: 'error',
                            message: error instanceof Error ? error.message : String(error)
                        }); 
                    }
                    break;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        try {
            // Get path to the React build directory
            const reactDistPath = path.join(this._extensionUri.fsPath, 'webview', 'dist');
            console.log('Looking for React build at:', reactDistPath);
            
            // Check if the build directory exists
            if (!fs.existsSync(reactDistPath)) {
                console.error('React build directory not found:', reactDistPath);
                return this._getFallbackHtml(); // Use embedded HTML as fallback
            }
            
            // List files in the directory to help debug
            console.log('Files in build directory:', fs.readdirSync(reactDistPath));
            
            // Get the index.html content
            const indexHtmlPath = path.join(reactDistPath, 'index.html');
            console.log('Looking for index.html at:', indexHtmlPath);
            
            if (!fs.existsSync(indexHtmlPath)) {
                console.error('index.html not found in React build directory');
                return this._getFallbackHtml(); // Use embedded HTML as fallback
            }
            
            let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
            console.log('Successfully loaded index.html');
            
            // Convert local paths to webview URIs
            indexHtml = indexHtml.replace(
                /(href|src)="([^"]+)"/g,
                (match, attr, value) => {
                    // Skip external URLs
                    if (value.startsWith('http') || value.startsWith('//')) {
                        return match;
                    }
                    
                    // Convert local path to webview URI
                    const localPath = path.join(reactDistPath, value);
                    const webviewUri = webview.asWebviewUri(vscode.Uri.file(localPath));
                    console.log(`Converting path: ${value} -> ${webviewUri}`);
                    return `${attr}="${webviewUri}"`;
                }
            );
            
            // Add CSP meta tag to allow scripts to run
            if (!indexHtml.includes('<meta http-equiv="Content-Security-Policy"')) {
                const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https:; connect-src ${webview.cspSource} https:;">`;
                indexHtml = indexHtml.replace('</head>', `${csp}\n</head>`);
            }
            
            console.log('Returning React webview HTML');
            return indexHtml;
        } catch (error) {
            console.error('Error loading React webview:', error);
            return this._getFallbackHtml(); // Use embedded HTML as fallback
        }
    }
    
    // Fallback to embedded HTML if React build is not available
    private _getFallbackHtml() {
        // Your current embedded HTML implementation
        return `
            <!DOCTYPE html>
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
            </html>
        `;
    }
}
