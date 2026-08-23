import * as vscode from 'vscode';
import { UPDATE_CHECK, STORAGE_KEYS } from '../../constants';

interface UpdateCheckState {
  lastCheckedAt: number;
  // Version we've already shown a notification for — never re-notify for
  // the same version, so a dismissed toast doesn't come back to nag daily.
  lastNotifiedVersion?: string;
}

interface OpenVsxMetadata {
  version?: string;
}

/**
 * Periodically checks Open VSX for a newer published version and, when one
 * exists, shows a single non-modal notification pointing the user at it.
 *
 * Why this matters here specifically: VS Code auto-updates Marketplace/Open
 * VSX installs on its own, but that covers only users who (a) have
 * `extensions.autoUpdate` on and (b) are on a fork whose product.json points
 * at a gallery that actually auto-updates. Anyone who installed the `.vsix`
 * by hand (our enterprise/offline path — see README "Manual install") gets
 * no signal at all otherwise, silently drifting from the current release.
 *
 * Deliberately un-naggy: at most one toast per new version, throttled to at
 * most one network check per CHECK_INTERVAL_MS, silent on any failure (a
 * flaky update check must never surface as user-facing noise), and fully
 * opt-out via the `workspacegpt.checkForUpdates` setting.
 */
export class UpdateChecker {
  private intervalId?: NodeJS.Timeout;
  private firstCheckTimeoutId?: NodeJS.Timeout;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public start(): void {
    // Delayed so the update check never competes with activation-critical work.
    this.firstCheckTimeoutId = setTimeout(() => {
      void this.checkNow();
    }, UPDATE_CHECK.FIRST_CHECK_DELAY_MS);
    this.intervalId = setInterval(() => {
      void this.checkNow();
    }, UPDATE_CHECK.CHECK_INTERVAL_MS);
  }

  public stop(): void {
    if (this.firstCheckTimeoutId) {
      clearTimeout(this.firstCheckTimeoutId);
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  private async checkNow(): Promise<void> {
    try {
      if (!vscode.workspace.getConfiguration('workspacegpt').get<boolean>('checkForUpdates', true)) {
        return;
      }

      const state = this.context.globalState.get<UpdateCheckState>(STORAGE_KEYS.UPDATE_CHECK_STATE);
      if (state?.lastCheckedAt && Date.now() - state.lastCheckedAt < UPDATE_CHECK.CHECK_INTERVAL_MS) {
        return;
      }

      const currentVersion =
        this.context.extension?.packageJSON?.version ||
        vscode.extensions.getExtension(UPDATE_CHECK.EXTENSION_ID)?.packageJSON?.version;
      if (!currentVersion) return;

      const latestVersion = await this.fetchLatestVersion();
      await this.context.globalState.update(STORAGE_KEYS.UPDATE_CHECK_STATE, {
        ...state,
        lastCheckedAt: Date.now(),
      } satisfies UpdateCheckState);

      if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) {
        return;
      }
      if (state?.lastNotifiedVersion === latestVersion) {
        return; // Already asked once for this version — don't nag again.
      }

      // Mark as notified up front (mirrors McpUiManager's welcome-toast
      // pattern) so a slow/duplicate timer tick can't show it twice.
      await this.context.globalState.update(STORAGE_KEYS.UPDATE_CHECK_STATE, {
        lastCheckedAt: Date.now(),
        lastNotifiedVersion: latestVersion,
      } satisfies UpdateCheckState);

      this.notify(currentVersion, latestVersion);
    } catch (error) {
      // Never let a failed update check surface as user-facing noise.
      console.error('WorkspaceGPT update check failed:', error);
    }
  }

  private async fetchLatestVersion(): Promise<string | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(UPDATE_CHECK.OPEN_VSX_API_URL, { signal: controller.signal });
      if (!res.ok) return undefined;
      const data = (await res.json()) as OpenVsxMetadata;
      return data.version;
    } finally {
      clearTimeout(timeout);
    }
  }

  private notify(currentVersion: string, latestVersion: string): void {
    const updateAction = 'Update Now';
    const notesAction = 'Release Notes';

    vscode.window
      .showInformationMessage(
        `WorkspaceGPT v${latestVersion} is available (you have v${currentVersion}).`,
        updateAction,
        notesAction
      )
      .then((selection) => {
        if (selection === updateAction) {
          // Works regardless of which gallery the host IDE is configured
          // against (Marketplace or Open VSX), unlike a hardcoded URL.
          void vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            UPDATE_CHECK.EXTENSION_ID
          );
        } else if (selection === notesAction) {
          void vscode.env.openExternal(
            vscode.Uri.parse(`${UPDATE_CHECK.RELEASES_URL}${latestVersion}`)
          );
        }
      });
  }
}

/**
 * Plain numeric dotted-version compare (extension versions are always plain
 * x.y.z per publish-targets.mjs — no semver pre-release/build metadata to
 * handle), so no extra dependency is pulled in just for this.
 */
function isNewerVersion(candidate: string, current: string): boolean {
  const a = candidate.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}
