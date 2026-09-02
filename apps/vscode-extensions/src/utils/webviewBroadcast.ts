/**
 * Host → webview push channel for code that runs outside a message handler.
 *
 * The sync schedulers are constructed during `activate()`, before any webview
 * exists, and keep running long after one is disposed — they can't hold a
 * `WebViewProvider` reference. They post through here instead: the provider
 * registers itself once, and posts made while no webview is up are dropped.
 * Dropping is correct: a webview that isn't running will hydrate from global
 * state when it starts, and global state is written before we ever post.
 */

type Poster = (message: unknown) => Thenable<boolean>;

let poster: Poster | undefined;

/** Called once by WebViewProvider. Later calls replace the previous target. */
export function registerWebviewPoster(fn: Poster): void {
  poster = fn;
}

/** Fire-and-forget: a missing or unresponsive webview must never fail a sync. */
export function postToWebview(message: unknown): void {
  try {
    void poster?.(message);
  } catch (err) {
    console.error('postToWebview failed:', err);
  }
}
