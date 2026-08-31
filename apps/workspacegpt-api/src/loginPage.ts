/** Branded "Continue with GitHub" landing page for GET /auth/login. Styled to
 *  match the extension's own OAuthCallbackServer success/error pages. */
export function renderLoginPage(githubAuthorizeUrl: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WorkspaceGPT</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 40px; background: #16213e; border-radius: 16px;">
    <div style="font-size: 48px; margin-bottom: 16px;">🔐</div>
    <h1 style="margin-bottom: 8px;">Sign in to WorkspaceGPT</h1>
    <p style="color: #a0a0a0; margin-bottom: 24px;">Continue with your GitHub account to enable remote mode.</p>
    <a href="${githubAuthorizeUrl}" style="display: inline-block; padding: 12px 24px; background: #4ecca3; color: #16213e; border-radius: 8px; text-decoration: none; font-weight: 600;">
      Continue with GitHub
    </a>
  </div>
</body></html>`;
}

export function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WorkspaceGPT</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
  <div style="text-align: center; padding: 40px; background: #16213e; border-radius: 16px;">
    <div style="font-size: 48px; margin-bottom: 16px;">❌</div>
    <h1 style="color: #e74c3c; margin-bottom: 8px;">Sign-in failed</h1>
    <p style="color: #a0a0a0;">${message}</p>
  </div>
</body></html>`;
}
