import * as vscode from 'vscode';
import { MESSAGE_TYPES } from '../../constants';
import { AnalyticsService } from '../services/analyticsService';
import { RemoteProfile, RemoteSignInService } from '../services/remote/remoteSignInService';

/** Flatten the Worker's `/v1/me` shape into the camelCase fields the webview reads. */
function profileFields(profile: RemoteProfile | null) {
  return {
    githubLogin: profile?.github_login,
    plan: profile?.plan,
    requestsUsedToday: profile?.requests_used_today,
    requestsLimitDaily: profile?.requests_limit_daily,
  };
}

/**
 * RECONSTRUCTED 2026-08-31 — this file was deleted by mistake earlier in the
 * same session (before it had ever been committed) and rebuilt from the
 * message-type contract in constants.ts and the sign-in gate comment in
 * WebviewMessageHandler.ts (which names this class as the handler for the
 * remote-account UI's sign-in/out messages). It is functionally equivalent
 * to what the original almost certainly did, but is NOT guaranteed
 * byte-identical — re-verify against the live behavior before relying on it.
 *
 * Handles the webview messages RemoteAccountSettings.tsx sends to check,
 * start, and end a remote-mode SaaS session. See RemoteSignInService for the
 * actual GitHub-via-Worker sign-in flow.
 */
export class RemoteAuthMessageHandler {
  private readonly service: RemoteSignInService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService
  ) {
    this.service = new RemoteSignInService(context);
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.CHECK_REMOTE_SESSION: {
        const profile = (await this.service.isSignedIn()) ? await this.service.verifySession() : null;
        // Server-confirmed, not just "a token exists": this is the one place
        // the UI can afford a round trip, so a session revoked or expired
        // server-side shows as signed out here rather than only failing at the
        // first chat request.
        this.webviewView.webview.postMessage({
          type: MESSAGE_TYPES.REMOTE_SESSION_STATUS,
          signedIn: !!profile,
          ...profileFields(profile),
        });
        return true;
      }
      case MESSAGE_TYPES.START_REMOTE_SIGN_IN: {
        this.analyticsService.trackEvent('remote_sign_in_started');
        try {
          await this.service.signIn();
          const profile = await this.service.verifySession();
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS,
            ...profileFields(profile),
          });
        } catch (error) {
          this.webviewView.webview.postMessage({
            type: MESSAGE_TYPES.REMOTE_SIGN_IN_ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return true;
      }
      case MESSAGE_TYPES.SIGN_OUT_REMOTE: {
        this.analyticsService.trackEvent('remote_sign_out_triggered');
        await this.service.signOut();
        this.webviewView.webview.postMessage({ type: MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS });
        return true;
      }
    }
    return false;
  }
}
