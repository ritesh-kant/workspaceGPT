import { PostHog } from 'posthog-node';
import * as vscode from 'vscode';

export class AnalyticsService {
  private posthog: PostHog;
  private userId: string;
  private isEnabled: boolean = true;

  constructor(private readonly context: vscode.ExtensionContext) {
    const POSTHOG_API_KEY = "phc_fu4MBqAfmFqDFLaaxRhsU718AtAxzYbyqdN4vtMk4ED"
    const POSTHOG_URL = "https://eu.i.posthog.com"

    // Initialize PostHog with your project API key
    this.posthog = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_URL,
    });

    // Get or create a unique user ID
    this.userId =
      (this.context.globalState.get('analytics.userId') as string) ||
      this.generateUserId();
    this.context.globalState.update('analytics.userId', this.userId);
  }

  private generateUserId(): string {
    return 'user_' + Math.random().toString(36).substring(2, 15);
  }

  public trackEvent(eventName: string, properties?: Record<string, any>): void {
    if (!this.isEnabled) return;

    try {
      this.posthog.capture({
        distinctId: this.userId,
        event: eventName,
        properties: {
          ...properties,
          extensionVersion: vscode.extensions.getExtension(
            'Riteshkant.workspacegpt-extension'
          )?.packageJSON.version,
          vscodeVersion: vscode.version,
        },
      });
    } catch (error) {
      console.error('Error tracking event:', error);
    }
  }

  public async flush(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      await this.posthog.shutdown();
    } catch (error) {
      console.error('Error flushing analytics:', error);
    }
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }
}
