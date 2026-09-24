import { PostHog } from 'posthog-node';
import * as vscode from 'vscode';
import { getMode } from '../utils/getModeSettings';

export class AnalyticsService {
  private posthog: PostHog;
  private userId: string;
  private isEnabled: boolean = true;
  private readonly isFirstRun: boolean;
  private sessionStartedAt: number | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  // 5 minutes — frequent enough to bound "time spent" resolution without flooding events.
  private static readonly HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

  constructor(private readonly context: vscode.ExtensionContext) {
    const POSTHOG_API_KEY = "phc_fu4MBqAfmFqDFLaaxRhsU718AtAxzYbyqdN4vtMk4ED"
    const POSTHOG_URL = "https://eu.i.posthog.com"

    // Initialize PostHog with your project API key.
    // disableGeoip defaults to true for server-side SDKs (a shared server's IP
    // usually isn't the end user's) — but this SDK runs on each user's own
    // machine, so their IP is the real signal. Enable it to get $geoip_country_name
    // etc. on every event.
    this.posthog = new PostHog(POSTHOG_API_KEY, {
      host: POSTHOG_URL,
      disableGeoip: false,
    });

    // Get or create a unique user ID. A stored id means this profile has run
    // the extension before, which is also how `trackInstall` tells a genuinely
    // new install from an upgrade.
    const storedUserId = this.context.globalState.get('analytics.userId') as
      | string
      | undefined;
    this.isFirstRun = !storedUserId;
    this.userId = storedUserId || this.generateUserId();
    this.context.globalState.update('analytics.userId', this.userId);
  }

  /**
   * Derives this install's distinctId from `vscode.env.machineId` — a stable
   * per-installation hash — rather than a random value. The old random id was
   * only ever persisted in globalState, so any environment that starts from an
   * empty profile (Marketplace scanners, CI containers, `--user-data-dir`
   * throwaways) minted a brand-new "person" on every single launch. Falls back
   * to a random id if machineId is somehow unavailable.
   */
  private generateUserId(): string {
    return vscode.env.machineId
      ? `machine_${vscode.env.machineId}`
      : 'user_' + Math.random().toString(36).substring(2, 15);
  }

  /**
   * Fires `extension_installed` once per profile, on the first activation after
   * install. `extension_activated` fires on *every* VS Code launch, so it can
   * never anchor an activation funnel: someone who installed months ago
   * re-enters step 1 each day and can only ever look like a drop-off. This is
   * the install-time anchor to use for that step instead.
   *
   * Profiles that already had an analytics id when this shipped are marked as
   * reported without emitting anything, so upgrading users don't show up as a
   * one-off wave of retroactive installs.
   */
  public trackInstall(): void {
    if (!this.isEnabled) return;
    if (this.context.globalState.get('analytics.installReported')) return;
    this.context.globalState.update('analytics.installReported', true);
    if (!this.isFirstRun) return;
    this.trackEvent('extension_installed');
  }

  /**
   * Attaches identifying traits (e.g. email from remote-mode sign-in) to this
   * install's distinctId, so PostHog's Persons view shows a real identity
   * instead of the anonymous `user_xxxxx` id. Safe to call repeatedly (e.g.
   * on every session-check) — PostHog merges properties into the existing person.
   */
  public identifyUser(properties: Record<string, any>): void {
    if (!this.isEnabled) return;

    try {
      this.posthog.identify({ distinctId: this.userId, properties });
    } catch (error) {
      console.error('Error identifying user:', error);
    }
  }

  public trackEvent(eventName: string, properties?: Record<string, any>): void {
    if (!this.isEnabled) return;

    try {
      this.posthog.capture({
        distinctId: this.userId,
        event: eventName,
        properties: {
          ...properties,
          extensionVersion: vscode.extensions.getExtension(
            'Riteshkant.workspacegpt-extension'
          )?.packageJSON.version,
          vscodeVersion: vscode.version,
          mode: getMode(this.context),
          // Which product sent this: the desktop app's posthog shim overwrites it
          // with "desktop"; `host` tells VS Code / Cursor / Antigravity apart.
          surface: 'extension',
          host: vscode.env.appName,
        },
      });
    } catch (error) {
      console.error('Error tracking event:', error);
    }
  }

  /**
   * Marks the start of a "time spent" window and begins emitting periodic
   * heartbeats. VS Code doesn't guarantee `deactivate()` runs (e.g. on crash
   * or forced quit), so the heartbeat's elapsed time is the durable signal —
   * `session_ended` on a clean shutdown is a nicer, precise capstone on top.
   */
  public startSession(): void {
    if (this.sessionStartedAt !== null) return;
    this.sessionStartedAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (this.sessionStartedAt === null) return;
      this.trackEvent('session_heartbeat', {
        elapsedSeconds: Math.round((Date.now() - this.sessionStartedAt) / 1000),
      });
    }, AnalyticsService.HEARTBEAT_INTERVAL_MS);
  }

  public endSession(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.sessionStartedAt === null) return;
    this.trackEvent('session_ended', {
      durationSeconds: Math.round((Date.now() - this.sessionStartedAt) / 1000),
    });
    this.sessionStartedAt = null;
  }

  public async flush(): Promise<void> {
    if (!this.isEnabled) return;

    try {
      await this.posthog.shutdown();
    } catch (error) {
      console.error('Error flushing analytics:', error);
    }
  }

  public setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
  }
}
