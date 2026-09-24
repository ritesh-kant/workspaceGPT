/**
 * `posthog-node` as the desktop sidecar sees it (esbuild alias).
 *
 * On in production builds (NODE_ENV=production, baked in by esbuild), off in
 * dev: dev and spike runs would otherwise land in the same PostHog project as
 * real extension users, and real usage there is single-digit — a few test
 * launches would visibly skew it. WGPT_DESKTOP_ANALYTICS=1 / =0 forces it
 * on / off at runtime either way. When on,
 * every event carries `surface: "desktop"` (challenge #13) on top of the
 * `vscodeVersion: "desktop-…"` the compat module already reports.
 */
// Resolved to the real package by absolute path in esbuild.config.mjs, so the alias doesn't loop.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Real = require('posthog-node-real').PostHog as new (key: string, opts?: unknown) => any;

const override = process.env.WGPT_DESKTOP_ANALYTICS;
const enabled = override === '1' || (override !== '0' && process.env.NODE_ENV === 'production');
let announced = false;

export class PostHog {
  private real: any;
  constructor(key: string, options?: unknown) {
    if (enabled) this.real = new Real(key, options);
    else if (!announced) {
      announced = true;
      console.log(
        override === '0'
          ? '[desktop] analytics off (WGPT_DESKTOP_ANALYTICS=0)'
          : '[desktop] analytics off in dev (set WGPT_DESKTOP_ANALYTICS=1 to send, tagged surface=desktop)'
      );
    }
  }
  capture(event: { properties?: Record<string, unknown> } & Record<string, unknown>): void {
    this.real?.capture({ ...event, properties: { ...event.properties, surface: 'desktop' } });
  }
  identify(payload: { properties?: Record<string, unknown> } & Record<string, unknown>): void {
    this.real?.identify({ ...payload, properties: { ...payload.properties, surface: 'desktop' } });
  }
  async flush(): Promise<void> {
    await this.real?.flush?.();
  }
  async shutdown(ms?: number): Promise<void> {
    await this.real?.shutdown?.(ms);
  }
}
