export interface Env {
  SESSIONS: KVNamespace;
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  /** Set via `wrangler secret put GITHUB_CLIENT_SECRET` (or .dev.vars locally). */
  GITHUB_CLIENT_SECRET: string;
  /**
   * The vendor's own OpenRouter key — the whole point of remote mode is that
   * users never hold a model key. Set via `wrangler secret put
   * OPENROUTER_API_KEY` (or .dev.vars locally). Every /v1/chat/completions
   * request spends against it, which is why the daily cap in usage.ts is not
   * optional.
   */
  OPENROUTER_API_KEY: string;
  /**
   * The single OpenRouter model id every remote-mode request is routed to.
   * Server-side config on purpose: changing the model is a `wrangler deploy`,
   * not an extension release.
   */
  OPENROUTER_MODEL: string;
  /** Daily per-user request cap for plans not listed in PLAN_DAILY_LIMITS. */
  DAILY_REQUEST_LIMIT: string;
}
