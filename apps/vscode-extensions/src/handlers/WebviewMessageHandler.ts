import * as vscode from 'vscode';
import { MESSAGE_TYPES } from '../../constants';
import { AnalyticsService } from '../services/analyticsService';
import { ConfluenceMessageHandler } from './ConfluenceMessageHandler';
import { AdoMessageHandler } from './AdoMessageHandler';
import { ChatMessageHandler } from './ChatMessageHandler';
import { CodebaseMessageHandler } from './CodebaseMessageHandler';
import { SystemMessageHandler } from './SystemMessageHandler';
import { HistoryService } from '../services/historyService';

export class WebviewMessageHandler {
  private analyticsService: AnalyticsService;
  private historyService: HistoryService;
  
  private confluenceHandler: ConfluenceMessageHandler;
  private adoHandler: AdoMessageHandler;
  private chatHandler: ChatMessageHandler;
  private codebaseHandler: CodebaseMessageHandler;
  private systemHandler: SystemMessageHandler;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext
  ) {
    this.analyticsService = new AnalyticsService(context);
    this.historyService = new HistoryService(context);

    // Initialize domain-specific handlers
    this.confluenceHandler = new ConfluenceMessageHandler(webviewView, context, this.analyticsService);
    this.adoHandler = new AdoMessageHandler(webviewView, context, this.analyticsService);
    this.chatHandler = new ChatMessageHandler(webviewView, context, this.analyticsService, this.historyService);
    this.codebaseHandler = new CodebaseMessageHandler(webviewView, context, this.analyticsService);
    this.systemHandler = new SystemMessageHandler(webviewView, context, this.analyticsService);

    // Warm the search workers now (webview is opening) so the first chat query is fast.
    this.chatHandler.prewarm();
  }

  /** Tear down chat search workers. Called on webview dispose. */
  public dispose(): void {
    this.chatHandler.dispose();
  }

  public async handleMessage(data: any): Promise<void> {
    if (data.type === MESSAGE_TYPES.RESET) {
      await this.reset();
      return;
    }

    // Delegate message to appropriate handler
    if (await this.confluenceHandler.handleMessage(data)) return;
    if (await this.adoHandler.handleMessage(data)) return;
    if (await this.chatHandler.handleMessage(data)) return;
    if (await this.codebaseHandler.handleMessage(data)) return;
    if (await this.systemHandler.handleMessage(data)) return;

    console.warn(`Unhandled message type: ${data.type}`);
  }

  private async reset() {
    try {
      // Orchestrate reset across all handlers
      await this.confluenceHandler.reset();
      await this.adoHandler.reset();
      await this.codebaseHandler.reset();
      await this.systemHandler.reset();
      this.chatHandler.dispose();
      
      console.log('WorkspaceGPT fully reset.');
    } catch (error) {
      console.error('Error during WorkspaceGPT reset:', error);
    }
  }
}
