import * as vscode from 'vscode';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../constants';
import { AnalyticsService } from '../services/analyticsService';
import { GitHubOAuthService } from '../services/deployment/githubOAuthService';
import { VercelAuthService } from '../services/deployment/vercelAuthService';
import { ConfluenceAuthService } from '../services/confluence/confluenceAuthService';
import { ConfluenceReleaseSource } from '../services/deployment/confluenceReleaseSource';
import { MachAuthService } from '../services/deployment/machAuthService';
import { MachSyncTarget, type MachSyncOptions } from '../services/deployment/machSyncTarget';
import * as path from 'path';
import { VercelTarget, OPAQUE_VALUE } from '../services/deployment/vercelTarget';
import {
  buildPlan,
  applicableChanges,
  hasUnresolvedConflicts,
  FileAuditLog,
  type ConfigVarDiff,
} from '@workspace-gpt/release-core';

/**
 * Handles the deployment-automation provider connections (GitHub App + Vercel)
 * surfaced in Settings → Deployment. These are write-scoped credentials, held
 * only in the VS Code master and never included in the Chrome share bundle.
 */
export class DeploymentMessageHandler {
  private githubAuth: GitHubOAuthService;
  private vercelAuth: VercelAuthService;
  private confluenceAuth: ConfluenceAuthService;
  private machAuth: MachAuthService;

  constructor(
    private readonly webviewView: vscode.WebviewView,
    private readonly context: vscode.ExtensionContext,
    private readonly analyticsService: AnalyticsService,
  ) {
    this.githubAuth = new GitHubOAuthService(this.context);
    this.vercelAuth = new VercelAuthService(this.context);
    this.confluenceAuth = new ConfluenceAuthService(this.context);
    this.machAuth = new MachAuthService(this.context);
  }

  /** Cancel any in-flight connect flow so its callback server releases the port. */
  public dispose(): void {
    this.githubAuth.cancelOAuthFlow();
    this.vercelAuth.cancelOAuthFlow();
  }

  public async handleMessage(data: any): Promise<boolean> {
    switch (data.type) {
      case MESSAGE_TYPES.CHECK_GITHUB_CONNECTION:
        await this.postGitHubStatus();
        return true;
      case MESSAGE_TYPES.START_GITHUB_INSTALL:
        this.analyticsService.trackEvent('github_install_started');
        await this.handleStartGitHubInstall();
        return true;
      case MESSAGE_TYPES.CANCEL_GITHUB_INSTALL:
        this.githubAuth.cancelOAuthFlow();
        return true;
      case MESSAGE_TYPES.DISCONNECT_GITHUB:
        this.analyticsService.trackEvent('github_disconnected');
        await this.githubAuth.disconnect();
        await this.postGitHubStatus();
        return true;

      case MESSAGE_TYPES.CHECK_VERCEL_CONNECTION:
        await this.postVercelStatus();
        return true;
      case MESSAGE_TYPES.START_VERCEL_OAUTH:
        this.analyticsService.trackEvent('vercel_oauth_started');
        await this.handleStartVercelOAuth();
        return true;
      case MESSAGE_TYPES.CANCEL_VERCEL_OAUTH:
        this.vercelAuth.cancelOAuthFlow();
        return true;
      case MESSAGE_TYPES.DISCONNECT_VERCEL:
        this.analyticsService.trackEvent('vercel_disconnected');
        await this.vercelAuth.disconnect();
        await this.postVercelStatus();
        return true;

      case MESSAGE_TYPES.GET_VERCEL_PROJECTS:
        await this.handleGetVercelProjects();
        return true;

      case MESSAGE_TYPES.CHECK_MACH_TOKEN:
        await this.postMachStatus();
        return true;
      case MESSAGE_TYPES.SET_MACH_TOKEN:
        this.analyticsService.trackEvent('mach_token_set');
        await this.handleSetMachToken(data);
        return true;
      case MESSAGE_TYPES.CLEAR_MACH_TOKEN:
        this.analyticsService.trackEvent('mach_token_cleared');
        await this.machAuth.clear();
        await this.postMachStatus();
        return true;
      case MESSAGE_TYPES.PLAN_MACH_SYNC:
        this.analyticsService.trackEvent('mach_sync_planned');
        await this.handlePlanMachSync(data);
        return true;
      case MESSAGE_TYPES.APPLY_MACH_SYNC:
        this.analyticsService.trackEvent('mach_sync_applied');
        await this.handleApplyMachSync(data);
        return true;
      case MESSAGE_TYPES.CHECK_MACH_RUN:
        await this.handleCheckMachRun(data);
        return true;

      case MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS:
        await this.handleTestConnections();
        return true;

      case MESSAGE_TYPES.RESOLVE_RELEASE:
        await this.handleResolveRelease();
        return true;
      case MESSAGE_TYPES.GET_RELEASE_RUNS:
        await this.handleGetReleaseRuns();
        return true;
      case MESSAGE_TYPES.PREPARE_CONFIG_SYNC:
        this.analyticsService.trackEvent('config_sync_prepared');
        await this.handlePrepareConfigSync(data);
        return true;
      case MESSAGE_TYPES.PLAN_CONFIG_SYNC:
        this.analyticsService.trackEvent('config_sync_planned');
        await this.handlePlanConfigSync(data);
        return true;
      case MESSAGE_TYPES.APPLY_CONFIG_SYNC:
        this.analyticsService.trackEvent('config_sync_applied');
        await this.handleApplyConfigSync(data);
        return true;
    }
    return false;
  }

  /** JSONL audit log for config-sync runs, under the extension's global storage. */
  private auditLog(): FileAuditLog {
    return new FileAuditLog(path.join(this.context.globalStorageUri.fsPath, 'deployment-runs.jsonl'));
  }

  /**
   * Resolve "today's release" for the Releases view via the Confluence
   * `ReleaseSource` (roster page → today's date → version + env + pilot). This
   * is read-only and touches nothing live. Reports `configured: false` with a
   * `reason` whenever it can't resolve, so the UI shows an honest empty state
   * instead of fabricating data.
   */
  private async handleResolveRelease(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const notConfigured = (reason: string) =>
      this.post(MESSAGE_TYPES.RESOLVE_RELEASE_RESPONSE, { configured: false, date: today, reason });

    try {
      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const rosterPageUrl: string | undefined = settings?.state?.config?.deployment?.rosterPageUrl;

      // Source of truth for "Confluence connected" is the stored OAuth tokens +
      // site (the webview `confluence.isConnected` flag isn't reliably set).
      const confluenceConnected =
        (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();

      if (!confluenceConnected) {
        return notConfigured('Connect Confluence (Settings → Confluence) to resolve releases.');
      }
      if (!rosterPageUrl) {
        return notConfigured('Set the Release Roster page URL in Settings → Deployment Automation.');
      }

      const source = new ConfluenceReleaseSource(this.confluenceAuth, { rosterPageUrl });
      const resolved = await source.resolveRelease(today);
      if (!resolved) {
        return notConfigured(`No release scheduled for ${today} on the roster.`);
      }

      this.post(MESSAGE_TYPES.RESOLVE_RELEASE_RESPONSE, {
        configured: true,
        date: resolved.date ?? today,
        version: resolved.version,
        environment: resolved.environment,
        pilot: resolved.pilot,
        pageUrl: resolved.pageUrl,
      });
    } catch (error) {
      notConfigured(errMessage(error));
    }
  }

  /** Recent config-sync runs, newest first, from the per-run audit summaries. */
  private async handleGetReleaseRuns(): Promise<void> {
    try {
      const entries = await this.auditLog().list();
      const runs = entries
        .filter((e) => !e.key && (e.action === 'applied' || e.action === 'failed')) // run summaries
        .slice(-10)
        .reverse()
        .map((e) => ({
          release: e.release,
          environment: e.environment,
          status: e.action as 'applied' | 'failed',
          at: e.at,
          detail: e.detail,
        }));
      this.post(MESSAGE_TYPES.GET_RELEASE_RUNS_RESPONSE, { runs });
    } catch {
      this.post(MESSAGE_TYPES.GET_RELEASE_RUNS_RESPONSE, { runs: [] });
    }
  }

  /**
   * Extract + preview the desired config for a resolved release. This is the
   * read-only first half of step d: it parses the release page's Configurations
   * table into desired config vars and returns them for review. It performs NO
   * live reads of Vercel/mach and writes nothing — the diff/apply targets land
   * in a later increment (open items #1/#3/#4).
   */
  private async handlePrepareConfigSync(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.PREPARE_CONFIG_SYNC_RESPONSE, { ok: false, error });

    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      if (!version) return fail('No release version to prepare. Resolve a release first.');

      const connected =
        (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();
      if (!connected) return fail('Connect Confluence (Settings → Confluence) first.');

      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const rosterPageUrl: string = settings?.state?.config?.deployment?.rosterPageUrl ?? '';

      const source = new ConfluenceReleaseSource(this.confluenceAuth, { rosterPageUrl });
      const vars = await source.fetchDesiredConfig(version, environment);

      this.post(MESSAGE_TYPES.PREPARE_CONFIG_SYNC_RESPONSE, {
        ok: true,
        version,
        environment,
        vars,
      });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  /**
   * Compute a read-only plan for the Vercel half of a release: parse desired
   * config, read live Vercel env vars for the mapped environment, and diff. No
   * writes. mach-targeted vars are returned as `skipped` (their GitRepoTarget
   * doesn't exist yet) rather than mis-classified as `add`.
   */
  private async handlePlanConfigSync(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.PLAN_CONFIG_SYNC_RESPONSE, { ok: false, error });

    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      if (!version) return fail('No release version to plan. Resolve a release first.');

      const { plan, target, vercelEnv, skipped, perEnvValues } = await this.buildVercelPlan(
        version,
        environment,
      );

      // When values are opaque (integration tokens can't decrypt), a present var
      // surfaces as an opaque update rather than a (meaningless) ciphertext diff.
      // Annotate vars whose live record is shared across environments so the UI
      // can show whether the change updates all of them or splits per-env.
      const valuesOpaque = !target.valuesDecrypted;
      const configVars = plan.configVars.map((r) => {
        const out: any = r.current === OPAQUE_VALUE ? { ...r, current: null, opaque: true } : { ...r };
        const linkedEnvs = target.linkedEnvCount(r.key);
        if (linkedEnvs > 1) {
          out.linkedEnvs = linkedEnvs;
          out.willSplit = perEnvValues;
        }
        return out;
      });

      this.post(MESSAGE_TYPES.PLAN_CONFIG_SYNC_RESPONSE, {
        ok: true,
        plan: { ...plan, configVars },
        skipped,
        vercelEnv,
        valuesOpaque,
        perEnvValues,
      });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  /**
   * Shared read-only plan builder for the Vercel half: validate connections +
   * settings, parse desired config, read live Vercel state, diff. Throws with an
   * actionable message on any gap. Used by both plan (preview) and apply.
   */
  private async buildVercelPlan(version: string, environment: string) {
    const connected =
      (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();
    if (!connected) throw new Error('Connect Confluence (Settings → Confluence) first.');
    if (!(await this.vercelAuth.isConnected())) throw new Error('Connect Vercel first.');

    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const dep = settings?.state?.config?.deployment ?? {};
    const projectId: string = dep.vercelProjectId ?? '';
    if (!projectId) throw new Error('Select a Vercel project in Settings → Deployment Automation.');

    const vercelEnv: string =
      environment === 'prod'
        ? dep.vercelEnvProd || 'production'
        : dep.vercelEnvStage || 'preview';

    const source = new ConfluenceReleaseSource(this.confluenceAuth, {
      rosterPageUrl: dep.rosterPageUrl ?? '',
    });
    const desired = await source.fetchDesiredConfig(version, environment);

    const vercelDesired = desired.filter((v) => v.target === 'vercel');
    const skipped = desired
      .filter((v) => v.target !== 'vercel')
      .map((v) => ({ key: v.key, target: v.target }));

    const perEnvValues = !!dep.vercelPerEnvValues;
    const target = new VercelTarget(this.vercelAuth, { projectId, vercelEnv, perEnvValues });
    const plan = await buildPlan({
      release: version,
      environment,
      desired: vercelDesired,
      targets: [target],
      now: new Date().toISOString(),
      source: `Vercel project ${dep.vercelProjectName || projectId} · ${vercelEnv}`,
    });

    return { plan, target, vercelEnv, skipped, perEnvValues };
  }

  /**
   * Apply the approved changes to Vercel. Recomputes the plan server-side (never
   * trusts a client-supplied diff), refuses if any conflict is unresolved, then
   * applies only add/update rows — optionally narrowed to `keys` (Retry failed).
   * Idempotent; every outcome is written to the audit log.
   */
  private async handleApplyConfigSync(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.APPLY_CONFIG_SYNC_RESPONSE, { ok: false, error });

    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      const onlyKeys: string[] | undefined = Array.isArray(data?.keys) ? data.keys : undefined;
      if (!version) return fail('No release version to apply.');

      const { plan, target } = await this.buildVercelPlan(version, environment);

      if (hasUnresolvedConflicts(plan.configVars)) {
        return fail('Plan has unresolved conflicts — resolve them before applying.');
      }

      let changes: ConfigVarDiff[] = applicableChanges(plan.configVars);
      if (onlyKeys) changes = changes.filter((c) => onlyKeys.includes(c.key));
      if (changes.length === 0) {
        this.post(MESSAGE_TYPES.APPLY_CONFIG_SYNC_RESPONSE, {
          ok: true,
          results: [],
          summary: { applied: 0, failed: 0, total: 0 },
          version,
          environment,
        });
        return;
      }

      const results = await target.apply(environment, changes);
      const applied = results.filter((r) => r.status === 'applied').length;
      const failed = results.filter((r) => r.status === 'failed').length;

      // Audit: one entry per variable, plus a single run summary (no `key`).
      const audit = this.auditLog();
      const at = new Date().toISOString();
      const actor = this.context.globalState.get<string>('userEmail') || undefined;
      await Promise.all(
        results.map((r) =>
          audit.record({
            at,
            release: version,
            environment,
            action: r.status === 'applied' ? 'applied' : r.status === 'failed' ? 'failed' : 'skipped',
            target: r.target,
            key: r.key,
            detail: r.error,
            actor,
          }),
        ),
      );
      await audit.record({
        at,
        release: version,
        environment,
        action: failed > 0 ? 'failed' : 'applied',
        actor,
        detail: `${applied}/${results.length} applied${failed ? `, ${failed} failed` : ''}`,
      });

      this.post(MESSAGE_TYPES.APPLY_CONFIG_SYNC_RESPONSE, {
        ok: true,
        results,
        summary: { applied, failed, total: results.length },
        version,
        environment,
      });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    this.webviewView.webview.postMessage({ type, ...payload });
  }

  // --- GitHub ---

  private async handleStartGitHubInstall(): Promise<void> {
    try {
      const tokens = await this.githubAuth.startOAuthFlow();
      this.post(MESSAGE_TYPES.GITHUB_INSTALL_SUCCESS, { scope: tokens.scope });
      await this.postGitHubStatus();
    } catch (error) {
      this.post(MESSAGE_TYPES.GITHUB_INSTALL_ERROR, { error: errMessage(error) });
    }
  }

  private async postGitHubStatus(): Promise<void> {
    const tokens = await this.githubAuth.getStoredTokens();
    this.post(MESSAGE_TYPES.GITHUB_CONNECTION_STATUS, {
      connected: tokens !== null,
      scope: tokens?.scope,
      connectedAt: tokens?.connectedAt,
    });
  }

  // --- Vercel ---

  private async handleStartVercelOAuth(): Promise<void> {
    try {
      const tokens = await this.vercelAuth.startOAuthFlow();
      this.post(MESSAGE_TYPES.VERCEL_OAUTH_SUCCESS, { teamId: tokens.teamId });
      await this.postVercelStatus();
    } catch (error) {
      this.post(MESSAGE_TYPES.VERCEL_OAUTH_ERROR, { error: errMessage(error) });
    }
  }

  private async postVercelStatus(): Promise<void> {
    const tokens = await this.vercelAuth.getStoredTokens();
    this.post(MESSAGE_TYPES.VERCEL_CONNECTION_STATUS, {
      connected: tokens !== null,
      teamId: tokens?.teamId,
      connectedAt: tokens?.connectedAt,
    });
  }

  /**
   * List the connected account's Vercel projects so the user can pick the
   * config-sync target from a dropdown (rather than typing an id). Scoped by the
   * integration's team when present.
   */
  private async handleGetVercelProjects(): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.GET_VERCEL_PROJECTS_RESPONSE, { ok: false, error });

    try {
      if (!(await this.vercelAuth.isConnected())) return fail('Connect Vercel first.');
      const token = await this.vercelAuth.getValidAccessToken();
      const tokens = await this.vercelAuth.getStoredTokens();

      const url = new URL('https://api.vercel.com/v9/projects');
      url.searchParams.set('limit', '100');
      if (tokens?.teamId) url.searchParams.set('teamId', tokens.teamId);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return fail(`Vercel API ${res.status}`);

      const data: any = await res.json();
      const projects = (data?.projects ?? []).map((p: any) => ({ id: p.id, name: p.name }));
      this.post(MESSAGE_TYPES.GET_VERCEL_PROJECTS_RESPONSE, { ok: true, projects });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  // --- mach (classic PAT) ---

  /**
   * Store a user-supplied classic PAT for mach in SecretStorage, then validate
   * it against both mach repos. The token is never echoed back to the webview;
   * only a boolean/validated status is posted.
   */
  private async handleSetMachToken(data: any): Promise<void> {
    try {
      const token: string = typeof data?.token === 'string' ? data.token : '';
      if (!token.trim()) {
        this.post(MESSAGE_TYPES.MACH_TOKEN_STATUS, {
          connected: false,
          detail: 'Paste a token to save.',
        });
        return;
      }
      await this.machAuth.setToken(token);
      await this.postMachStatus();
    } catch (error) {
      this.post(MESSAGE_TYPES.MACH_TOKEN_STATUS, { connected: false, detail: errMessage(error) });
    }
  }

  private async postMachStatus(): Promise<void> {
    if (!(await this.machAuth.isConnected())) {
      this.post(MESSAGE_TYPES.MACH_TOKEN_STATUS, { connected: false });
      return;
    }
    const status = await this.machAuth.validate();
    this.post(MESSAGE_TYPES.MACH_TOKEN_STATUS, { ...status });
  }

  /**
   * Build a mach sync target from settings + the resolved release environment.
   * `from`/brand/branch are user settings (overridable per-run); `to` is mapped
   * from the release environment (stage/prod). Throws with an actionable message
   * when the token isn't set or the source env is unconfigured.
   */
  private async buildMachTarget(environment: string, overrides: any = {}) {
    if (!(await this.machAuth.isConnected())) {
      throw new Error('Set a mach GitHub token in Settings → Deployment Automation first.');
    }
    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const dep = settings?.state?.config?.deployment ?? {};

    const brand: string = overrides.brand || dep.machBrand || 'mms';
    const from: string = overrides.from || dep.machSourceEnv || '';
    if (!from) {
      throw new Error('Set the mach source environment (e.g. test01) in Settings → Deployment Automation.');
    }
    const to: string =
      overrides.to ||
      (environment === 'prod' ? dep.machEnvProd || 'prod' : dep.machEnvStage || 'stage');
    const fromBranch: string = overrides.fromBranch || dep.machFromBranch || 'main';
    const updateMainYml: boolean =
      typeof overrides.updateMainYml === 'boolean'
        ? overrides.updateMainYml
        : dep.machUpdateMainYml !== false;

    const opts: MachSyncOptions = { brand, from, to, fromBranch, updateMainYml };
    return { target: new MachSyncTarget(this.machAuth, opts), opts };
  }

  /**
   * Read-only preview of the mach component-version promotion: fetch the source
   * and destination `components.yml` and compute exactly the changes the workflow
   * would make. Writes nothing.
   */
  private async handlePlanMachSync(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.PLAN_MACH_SYNC_RESPONSE, { ok: false, error });
    try {
      const environment: string = data?.environment || 'stage';
      const { target, opts } = await this.buildMachTarget(environment, data?.overrides);
      const changes = await target.planComponentDiff();
      this.post(MESSAGE_TYPES.PLAN_MACH_SYNC_RESPONSE, {
        ok: true,
        environment,
        from: opts.from,
        to: opts.to,
        brand: opts.brand,
        updateMainYml: opts.updateMainYml,
        changes,
      });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  /**
   * Trigger the mach sync workflow. Returns once the run is located; the PR lands
   * ~5 min later (poll via CHECK_MACH_RUN). Records the trigger in the audit log.
   */
  private async handleApplyMachSync(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.APPLY_MACH_SYNC_RESPONSE, { ok: false, error });
    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      const { target, opts } = await this.buildMachTarget(environment, data?.overrides);

      const at = new Date().toISOString();
      const run = await target.triggerSync(at);

      const actor = this.context.globalState.get<string>('userEmail') || undefined;
      await this.auditLog().record({
        at,
        release: version || `${opts.from}→${opts.to}`,
        environment,
        action: 'applied',
        target: 'mach',
        actor,
        detail: `dispatched sync ${opts.from}→${opts.to} (run ${run.runId})`,
      });

      this.post(MESSAGE_TYPES.APPLY_MACH_SYNC_RESPONSE, {
        ok: true,
        environment,
        from: opts.from,
        to: opts.to,
        brand: opts.brand,
        run,
      });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  /**
   * Poll a previously-triggered mach run: current status + the PR once it opens.
   * The webview calls this on an interval until the PR appears or the run fails.
   */
  private async handleCheckMachRun(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.CHECK_MACH_RUN_RESPONSE, { ok: false, error });
    try {
      const runId: number | undefined = data?.runId;
      const environment: string = data?.environment || 'stage';
      if (!runId) return fail('No run id to check.');
      const { target } = await this.buildMachTarget(environment, data?.overrides);

      const status = await target.getRunStatus(runId);
      const pr = await target.findPullRequest(runId);
      this.post(MESSAGE_TYPES.CHECK_MACH_RUN_RESPONSE, { ok: true, run: status, pr });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  // --- Test all connections ---

  /**
   * Liveness check before a release night: confirm each connected provider's
   * token actually works (mint a GitHub token, call Vercel's whoami) rather than
   * just checking that something is stored. Reports per-provider results.
   */
  private async handleTestConnections(): Promise<void> {
    const results: Record<string, { ok: boolean; detail?: string }> = {};

    if (await this.githubAuth.isConnected()) {
      try {
        const token = await this.githubAuth.getValidAccessToken();
        const res = await fetch('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'workspacegpt',
          },
        });
        results.github = res.ok
          ? { ok: true }
          : { ok: false, detail: `GitHub API ${res.status}` };
      } catch (error) {
        results.github = { ok: false, detail: errMessage(error) };
      }
    } else {
      results.github = { ok: false, detail: 'Not connected' };
    }

    if (await this.vercelAuth.isConnected()) {
      try {
        const tokens = await this.vercelAuth.getStoredTokens();
        const token = await this.vercelAuth.getValidAccessToken();
        // Integration tokens are scoped to a team/installation and have no
        // personal-user context, so `/v2/user` 404s. Probe `/v9/projects`
        // (scoped by teamId when present) — the access this feature actually
        // uses to write frontend env vars.
        const url = new URL('https://api.vercel.com/v9/projects');
        url.searchParams.set('limit', '1');
        if (tokens?.teamId) url.searchParams.set('teamId', tokens.teamId);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        results.vercel = res.ok
          ? { ok: true }
          : { ok: false, detail: `Vercel API ${res.status}` };
      } catch (error) {
        results.vercel = { ok: false, detail: errMessage(error) };
      }
    } else {
      results.vercel = { ok: false, detail: 'Not connected' };
    }

    if (await this.machAuth.isConnected()) {
      const status = await this.machAuth.validate();
      results.mach =
        status.repos?.monorepo && status.repos?.stage
          ? { ok: true }
          : { ok: false, detail: status.detail ?? 'Cannot reach both mach repos' };
    } else {
      results.mach = { ok: false, detail: 'Not connected' };
    }

    this.post(MESSAGE_TYPES.TEST_DEPLOYMENT_CONNECTIONS_RESULT, { results });
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
