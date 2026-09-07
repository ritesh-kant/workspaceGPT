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
   * The key for any non-OpenRouter, OpenAI-compatible vendor — TokenRouter, GMI
   * Cloud, a self-hosted endpoint, whatever comes next. Only required when the
   * resolved provider is `custom` (see CUSTOM_API_BASE_URL below). Set via
   * `wrangler secret put CUSTOM_API_KEY` (or .dev.vars locally).
   */
  CUSTOM_API_KEY?: string;
  // ── Deploy-time defaults ────────────────────────────────────────────────
  // Each of these is overridable at runtime by an `app_config` row, with no
  // deploy at all — see src/config.ts for the precedence rules. They are the
  // committed defaults, not the last word.

  /** Which upstream vendor remote-mode requests are routed to: "openrouter" or "custom" — see config.ts. */
  INFERENCE_PROVIDER: string;
  /**
   * The chat-completions URL for the `custom` provider (e.g.
   * `https://api.tokenrouter.com/v1/chat/completions`). Ignored unless
   * INFERENCE_PROVIDER is `custom`; that's the only place this is read.
   */
  CUSTOM_API_BASE_URL?: string;
  /** Model id for the `openrouter` provider. Ignored when INFERENCE_PROVIDER is `custom`. */
  OPENROUTER_MODEL: string;
  /**
   * Model id for the `custom` provider, in whatever format that vendor
   * expects (e.g. `z-ai/glm-5.3-free` for TokenRouter). Ignored unless
   * INFERENCE_PROVIDER is `custom`.
   */
  CUSTOM_MODEL?: string;
  /** JSON `{"plan": creditsPerWeek}` map, e.g. `{"free":2000,"pro":50000}`. */
  PLAN_WEEKLY_CREDITS?: string;
  /** Credits/week for a plan absent from PLAN_WEEKLY_CREDITS. */
  WEEKLY_CREDIT_LIMIT?: string;
  /** Vendor tokens per credit (default 1000). */
  TOKENS_PER_CREDIT?: string;
}
