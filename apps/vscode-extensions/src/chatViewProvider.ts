import * as vscode from 'vscode';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
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

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the WebView
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
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
                        // body: JSON.stringify({
                            //     messages: [{ role: 'user', content: data.message }]
                            // })
                        
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
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WorkspaceGPT Chat</title>
                <style>
                    body {
                        padding: 10px;
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
                    <div class="loading">Processing...</div>
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
