/**
 * In-memory mirror of the remote-mode session token.
 *
 * The token lives in `SecretStorage`, which is async-only, but the token is
 * needed by {@link getLlmSettings} — a synchronous function called from
 * several sync code paths (e.g. DeploymentMessageHandler's `hasLlm()`). Rather
 * than turn that whole call tree async for a value that changes twice in a
 * session (sign-in, sign-out), the token is primed once on activation and kept
 * current by RemoteSignInService, which is the only writer.
 *
 * This is a cache of a credential, not an authority on it: the Worker
 * re-validates the session on every inference request, so a stale value here
 * fails closed with a 401 rather than granting anything.
 */
let cachedToken: string | undefined;

export function setCachedRemoteSessionToken(token: string | undefined): void {
  cachedToken = token;
}

export function getCachedRemoteSessionToken(): string | undefined {
  return cachedToken;
}
