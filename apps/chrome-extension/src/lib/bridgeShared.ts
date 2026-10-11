/** What the side panel and the service worker agree on — kept apart from browserControl.ts so the panel does not bundle the debugger code. */

export const BRIDGE_STATUS_KEY = 'browserBridgeStatus';
export const CHAT_PORT_NAME = 'wgpt-chat';

export interface BridgeStatus {
  connected: boolean;
  /** Why the last attempt failed — usually that WorkspaceGPT Desktop is not running or not installed. */
  error?: string;
  at: number;
}
