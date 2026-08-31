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
  // ── Deploy-time defaults ────────────────────────────────────────────────
  // Each of these is overridable at runtime by an `app_config` row, with no
  // deploy at all — see src/config.ts for the precedence rules. They are the
  // committed defaults, not the last word.

  /** The single OpenRouter model id remote-mode requests are routed to. */
  OPENROUTER_MODEL: string;
  /** JSON `{"plan": requestsPerDay}` map, e.g. `{"free":200,"pro":5000}`. */
  PLAN_DAILY_LIMITS: string;
  /** Requests/day for a plan absent from PLAN_DAILY_LIMITS. */
  DAILY_REQUEST_LIMIT: string;
}
