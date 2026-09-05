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
   * request spends against it, which is why the credit caps in metering.ts
   * are not optional.
   */
  OPENROUTER_API_KEY: string;
  /**
   * The vendor's GMI Cloud key, only required when the resolved provider is
   * `gmicloud`. Set via `wrangler secret put GMICLOUD_API_KEY` (or .dev.vars
   * locally).
   */
  GMICLOUD_API_KEY?: string;
  // ── Deploy-time defaults ────────────────────────────────────────────────
  // Each of these is overridable at runtime by an `app_config` row, with no
  // deploy at all — see src/config.ts for the precedence rules. They are the
  // committed defaults, not the last word.

  /** Which upstream vendor remote-mode requests are routed to — see PROVIDERS in config.ts. */
  INFERENCE_PROVIDER: string;
  /** The model id remote-mode requests are routed to, in the chosen provider's format. */
  OPENROUTER_MODEL: string;
  /** JSON `{"plan": creditsPerWeek}` map, e.g. `{"free":2000,"pro":50000}`. */
  PLAN_WEEKLY_CREDITS?: string;
  /** Credits/week for a plan absent from PLAN_WEEKLY_CREDITS. */
  WEEKLY_CREDIT_LIMIT?: string;
  /** JSON `{"plan": creditsPer5hWindow}` map. Absent plans get weekly/5 (metering.ts). */
  PLAN_WINDOW_CREDITS?: string;
  /** Window credits for a plan absent from PLAN_WINDOW_CREDITS. Absent: weekly/5. */
  WINDOW_CREDIT_LIMIT?: string;
  /** Vendor tokens per credit (default 1000). */
  TOKENS_PER_CREDIT?: string;
}
