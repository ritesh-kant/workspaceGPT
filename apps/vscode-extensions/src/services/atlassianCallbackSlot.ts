/**
 * Confluence and Jira sign-in share one Atlassian app, so they share one
 * loopback callback port (ATLASSIAN_OAUTH.CALLBACK_PORT). Only one flow can
 * hold it: a flow left pending (closed browser tab, retry, the other product)
 * would otherwise make the next one fail with EADDRINUSE until its 5-minute
 * timeout. Each flow claims the slot first, which cancels whichever holds it.
 */
let cancelActive: (() => void) | null = null;

export function claimAtlassianCallbackSlot(cancel: () => void): void {
  const previous = cancelActive;
  cancelActive = cancel;
  previous?.();
}
