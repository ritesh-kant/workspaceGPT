import * as vscode from 'vscode';
import { EmbeddingManager } from './embeddingService';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class ChatService {
  private embeddingManager: EmbeddingManager;
  private webviewView: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private chatHistory: ChatMessage[] = [];

  constructor(webviewView: vscode.WebviewView, context: vscode.ExtensionContext) {
    this.webviewView = webviewView;
    this.context = context;
    this.embeddingManager = new EmbeddingManager(webviewView, context);
  }

  public async newChat(): Promise<void> {
    // Clear chat history
    this.chatHistory = [];

    // Notify webview
    this.webviewView.webview.postMessage({
      type: 'newChatCreated'
    });
  }

  public async sendMessage(message: string): Promise<void> {
    try {
      // Add user message to history
      this.chatHistory.push({
        role: 'user',
        content: message
      });

      // Search embeddings
      const searchResults = await this.embeddingManager.searchEmbeddings(message);

      // Format search results as markdown
      const formattedResults = this.formatSearchResults(searchResults);

      // Add assistant response to history
      this.chatHistory.push({
        role: 'assistant',
        content: formattedResults
      });

      // Stream response to webview
      await this.streamResponse(formattedResults);

    } catch (error) {
      console.error('Error in chat:', error);
      this.webviewView.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private formatSearchResults(results: { text: string; score: number; source: string }[]): string {
    if (!results.length) {
      return 'No relevant information found.';
    }

    let markdown = '### Related Information\n\n';
    
    results.forEach((result, index) => {
      markdown += `#### Source: ${result.source}\n\n`;
      markdown += `${result.text}\n\n`;
      markdown += `*Relevance Score: ${(result.score * 100).toFixed(2)}%*\n\n`;
      if (index < results.length - 1) {
        markdown += '---\n\n';
      }
    });

    return markdown;
  }

  private async streamResponse(content: string): Promise<void> {
    const chunkSize = 50; // Characters per chunk
    const delay = 30; // Milliseconds between chunks

    for (let i = 0; i < content.length; i += chunkSize) {
      const chunk = content.slice(i, i + chunkSize);
      this.webviewView.webview.postMessage({
        type: 'streamResponse',
        content: chunk,
        isComplete: i + chunkSize >= content.length
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}