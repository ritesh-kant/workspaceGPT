import * as vscode from 'vscode';
import {
  MESSAGE_TYPES,
  STORAGE_KEYS,
  EMPTY_MACH_REPO,
  GITHUB_API_BASE,
  legacyToDescriptor,
  type MachRepoConfig,
  type PipelineDescriptor,
  type PipelineSource,
  type ActionProvider,
} from '../../constants';
import { AnalyticsService } from '../services/analyticsService';
import { GitHubOAuthService } from '../services/deployment/githubOAuthService';
import { VercelAuthService } from '../services/deployment/vercelAuthService';
import { ConfluenceAuthService } from '../services/confluence/confluenceAuthService';
import { ConfluenceReleaseSource, buildTargetFor } from '../services/deployment/confluenceReleaseSource';
import { AiReleaseSource, type AiMode } from '../services/deployment/aiReleaseSource';
import { FileReleaseSource } from '../services/deployment/fileReleaseSource';
import { getLlmSettings } from '../utils/getLlmSettings';
import { withKeyFailover, isRateLimitError } from '../utils/apiKeyFailover';
import { MachAuthService } from '../services/deployment/machAuthService';
import { MachSyncTarget, setComponentVersion, type MachSyncOptions } from '../services/deployment/machSyncTarget';
import { MachEnvTarget, NoSyncPrError } from '../services/deployment/machEnvTarget';
import { defaultMainYmlCodec } from '../services/deployment/mainYmlCodec';
import { readVercelDeployedVersion } from '../services/deployment/vercelDeployments';
import * as path from 'path';
import { VercelTarget, OPAQUE_VALUE } from '../services/deployment/vercelTarget';
import {
  buildPlan,
  applicableChanges,
  hasUnresolvedConflicts,
  FileAuditLog,
  type ConfigVarDiff,
  type ReleaseSource,
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

      case MESSAGE_TYPES.DISCOVER_GITHUB:
        await this.handleDiscoverGithub(data);
        return true;

      case MESSAGE_TYPES.DISCOVER_ROSTER_COLUMNS:
        await this.handleDiscoverRosterColumns();
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
      case MESSAGE_TYPES.PLAN_MACH_ENV:
        await this.handlePlanMachEnv(data);
        break;
      case MESSAGE_TYPES.APPLY_MACH_ENV:
        await this.handleApplyMachEnv(data);
        break;
      case MESSAGE_TYPES.INJECT_WEBAPP_VERSION:
        this.analyticsService.trackEvent('mach_webapp_version_injected');
        await this.handleInjectWebappVersion(data);
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
      const dep = settings?.state?.config?.deployment ?? {};
      const rosterPageUrl: string | undefined = this.sourceConfig(dep).rosterPageUrl;

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

      const source = this.buildReleaseSource(dep);
      const resolved = await source.resolveRelease(today);
      if (!resolved) {
        return notConfigured(`No release scheduled for ${today} on the roster.`);
      }
      if (resolved.needsVersion) {
        return this.post(MESSAGE_TYPES.RESOLVE_RELEASE_RESPONSE, {
          configured: false,
          needsVersion: true,
          date: resolved.date ?? today,
          environment: resolved.environment,
          pilot: resolved.pilot,
          reason: `Release scheduled for ${today} (env ${resolved.environment}) but no version is listed on the roster — enter it below.`,
        });
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
      const version: string = data?.version || '';
      const pageUrl: string | undefined = data?.pageUrl || undefined;
      const environment: string = data?.environment || 'stage';
      if (!version && !pageUrl) {
        return fail('Enter a version or paste the release page URL, then try again.');
      }

      const connected =
        (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();
      if (!connected) return fail('Connect Confluence (Settings → Confluence) first.');

      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const dep = settings?.state?.config?.deployment ?? {};

      const source = this.buildReleaseSource(dep);
      const vars = await source.fetchDesiredConfig(version, environment, pageUrl);

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
   * Resolve an engine environment name to its declared {@link DeploymentEnvironment}.
   *
   * Prefers the configured `environments` list (N-ary, org-agnostic). Falls back
   * to the legacy binary `stage`/`prod` fields so existing configs keep working
   * unchanged — the fallback never enables auto-merge (safe default). This is the
   * single seam that removes the hardcoded stage/prod assumption from the
   * env→target mapping.
   */
  /**
   * Build the Confluence release source from settings — roster URL plus any
   * configured column overrides (from the discover-and-select dropdowns). One
   * place so every caller stays consistent.
   */
  private buildConfluenceSource(dep: any): ConfluenceReleaseSource {
    const src = this.sourceConfig(dep);
    return new ConfluenceReleaseSource(this.confluenceAuth, {
      rosterPageUrl: src.rosterPageUrl ?? '',
      columns: src.rosterColumns,
      targetFor: buildTargetFor(src.targetMap),
    });
  }

  /**
   * The release source for resolve/fetch. When AI-assisted parsing is opted in
   * (and a chat model is configured), wrap the deterministic source so it falls
   * back to the LLM on a parse failure — AI proposes, the source validates, and
   * the existing plan→approve gate is the human backstop. Otherwise pure
   * deterministic, so an unconfigured install is unchanged.
   */
  private buildReleaseSource(dep: any): ReleaseSource {
    const src = this.sourceConfig(dep);

    if (src.provider === 'file') {
      const apiBase =
        this.actionConfig(dep, 'github-workflow-dispatch').repo?.apiBase || GITHUB_API_BASE;
      return new FileReleaseSource(this.machAuth, {
        apiBase,
        owner: src.fileRepoOwner ?? '',
        repo: src.fileRepoName ?? '',
        path: src.filePath ?? '',
        ref: src.fileRef ?? 'main',
      });
    }

    // manual / none / jira — no automatic source; resolve/fetch return empty.
    if (src.provider !== 'confluence-roster') {
      return {
        async resolveRelease() {
          return null;
        },
        async fetchDesiredConfig() {
          return [];
        },
      };
    }

    const deterministic = this.buildConfluenceSource(dep);
    const hasLlm = this.hasLlm();

    // Both roster resolve and config sync default to *always* using AI when a
    // chat model is configured — release-page and roster layouts vary too much
    // per-org for deterministic header/date matching to be reliable. Each parse
    // is independent — enabling one does not silently enable the other.
    // Both flags default ON — unset means enabled; only an explicit `false`
    // disables them. The deterministic parser only runs when no chat model is
    // configured at all (there's no AI to call in that case).
    const aiAssist = src.aiAssistParsing !== false;
    const aiConfig = src.aiConfigSync !== false;
    const resolveMode: AiMode = aiAssist && hasLlm ? 'always' : 'deterministic';
    const configMode: AiMode = !hasLlm
      ? 'deterministic'
      : aiConfig
        ? 'always'
        : aiAssist
          ? 'fallback'
          : 'deterministic';

    if (resolveMode === 'deterministic' && configMode === 'deterministic') return deterministic;

    return new AiReleaseSource(deterministic, (prompt) => this.aiComplete(prompt), {
      resolveMode,
      configMode,
      targetMap: src.targetMap,
    });
  }

  /** Whether a chat model is configured (Settings → Model) for AI-assisted parsing. */
  private hasLlm(): boolean {
    const s = getLlmSettings(this.context);
    return !!(s.provider && s.baseUrl && s.model);
  }

  /** One-shot LLM completion via the configured OpenAI-compatible provider. */
  private async aiComplete(prompt: string): Promise<string> {
    const s = getLlmSettings(this.context);
    if (!s.provider || !s.baseUrl || !s.model) {
      throw new Error('Select a chat model (Settings → Model) to use AI-assisted parsing.');
    }
    const OpenAI = (await import('openai')).default;
    // Try each configured key in turn, rotating on 429. maxRetries lets the SDK
    // back off and honor Retry-After before we give up on a given key — the
    // common case for rate-limited or free-tier chat providers.
    const keys = s.apiKeys.length ? s.apiKeys : ['local'];
    try {
      return await withKeyFailover(keys, async (apiKey) => {
        const client = new OpenAI({ apiKey: apiKey || 'local', baseURL: s.baseUrl, maxRetries: 4 });
        const res = await client.chat.completions.create({
          model: s.model!,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          // Generous ceiling: config-sync responses can be long JSON arrays, and
          // thinking models (e.g. gemini-2.5-*) also spend tokens reasoning. Too
          // low here truncates the JSON → "not valid JSON".
          max_tokens: 8192,
        });
        return res.choices[0]?.message?.content?.trim() || '';
      });
    } catch (err: any) {
      // Translate the SDK's opaque "<status> status code (no body)" errors into
      // something the user can act on.
      if (isRateLimitError(err)) {
        // Only reached once every key is rate-limited.
        throw new Error(
          'Chat model rate-limited (HTTP 429) after trying all configured API keys. Add another key or wait, then retry — or check your provider quota (Settings → Model). You can also untick "Always use AI for config sync" to use deterministic parsing instead.',
        );
      }
      const status = err?.status ?? err?.response?.status;
      if (typeof status === 'number' && status >= 500) {
        // Provider-side outage (e.g. 503). The SDK already retried; extra API
        // keys don't help since they hit the same endpoint.
        throw new Error(
          `Chat model provider is temporarily unavailable (HTTP ${status}) after retries. This is a provider-side outage, not a key problem — wait a moment and try again. If it persists, untick "Always use AI for config sync" to use deterministic parsing instead.`,
        );
      }
      throw err;
    }
  }

  /** The pipeline descriptor (single config source). Migrates legacy flat
   *  settings into a descriptor when none is saved yet. */
  private getPipeline(dep: any): PipelineDescriptor {
    return dep?.pipeline ?? legacyToDescriptor(dep ?? {});
  }

  /** Config of the first action with the given provider, or `{}` if none. */
  private actionConfig(dep: any, provider: ActionProvider): Record<string, any> {
    const desc = this.getPipeline(dep);
    for (const stage of desc.stages) {
      for (const action of stage.actions) {
        if (action.provider === provider) return action.config ?? {};
      }
    }
    return {};
  }

  /** The pipeline's source config. */
  private sourceConfig(dep: any): PipelineSource {
    return this.getPipeline(dep).source;
  }

  /** Per-environment policy (auto-merge) from the declared environments. */
  private resolveEnv(dep: any, environment: string): { autoMerge: boolean } {
    const envs = this.getPipeline(dep).environments ?? [];
    const found = envs.find((e) => e?.name === environment);
    return { autoMerge: found?.autoMerge === true };
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
    const v = this.actionConfig(dep, 'vercel-config');
    const projectId: string = v.projectId ?? '';
    if (!projectId) throw new Error('Select a Vercel project in Settings → Deployment Automation.');

    const vercelEnv: string =
      environment === 'prod' ? v.envProd || 'production' : v.envStage || 'preview';

    const source = this.buildReleaseSource(dep);
    const desired = await source.fetchDesiredConfig(version, environment);

    const vercelDesired = desired.filter((v) => v.target === 'vercel');
    const skipped = desired
      .filter((v) => v.target !== 'vercel')
      .map((v) => ({ key: v.key, target: v.target }));

    const perEnvValues = !!v.perEnvValues;
    const target = new VercelTarget(this.vercelAuth, { projectId, vercelEnv, perEnvValues });
    const plan = await buildPlan({
      release: version,
      environment,
      desired: vercelDesired,
      targets: [target],
      now: new Date().toISOString(),
      source: `Vercel project ${v.projectName || projectId} · ${vercelEnv}`,
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

  /**
   * Set a component's version in the open mach PR to the version Vercel has
   * deployed for the source environment (parsed from the latest READY
   * deployment's commit message). The component + Vercel project are pipeline
   * config (Settings → Deployment Automation → "Once the PR opens"), not
   * hardcoded — a component normally on `@skipdeploy` because it ships via
   * Vercel gets its real deployed version injected into the PR branch's
   * components.yml. Idempotent — a no-op when the version already matches.
   */
  private async handleInjectWebappVersion(data: any): Promise<void> {
    const fail = (error: string) =>
      this.post(MESSAGE_TYPES.INJECT_WEBAPP_VERSION_RESPONSE, { ok: false, error });
    try {
      const runId: number | undefined = data?.runId;
      const environment: string = data?.environment || 'stage';
      if (!runId) return fail('No run id — trigger the sync first.');
      if (!(await this.vercelAuth.isConnected())) return fail('Connect Vercel first.');

      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const dep = settings?.state?.config?.deployment ?? {};
      const m = this.actionConfig(dep, 'github-workflow-dispatch');
      const versionInjection = m.versionInjection ?? {};
      const component: string = data?.component || versionInjection.component || 'webapp';
      const projectId: string = versionInjection.vercelProjectId || this.actionConfig(dep, 'vercel-config').projectId || '';
      if (!projectId) return fail('Select the frontend Vercel project in Settings → Deployment Automation.');

      const { target, opts } = await this.buildMachTarget(environment, data?.overrides);

      // 1. Version Vercel actually deployed to the source env. AI-assisted
      // extraction when a chat model is configured — commit-message formats
      // vary by org, so a fixed regex can't cover them all.
      const deployed = await readVercelDeployedVersion(
        this.vercelAuth,
        projectId,
        opts.from,
        this.hasLlm() ? (prompt) => this.aiComplete(prompt) : undefined,
      );

      // 2. Read the PR branch's components.yml and splice the webapp version in.
      const branch = target.syncBranch(runId);
      const file = await target.readDestFile(branch, 'components.yml');
      if (!file) return fail(`components.yml not found on ${branch}.`);

      const result = setComponentVersion(file.content, component, deployed.version);
      if (!result.changed) {
        this.post(MESSAGE_TYPES.INJECT_WEBAPP_VERSION_RESPONSE, {
          ok: true,
          changed: false,
          component,
          version: deployed.version,
          oldValue: result.oldValue,
          commitMessage: deployed.commitMessage,
        });
        return;
      }

      // 3. Commit to the PR branch (the PR updates itself).
      await target.commitDestFile(
        branch,
        'components.yml',
        result.text,
        file.sha,
        `Set ${component} to ${deployed.version} (deployed on ${opts.from})`,
      );

      await this.auditLog().record({
        at: new Date().toISOString(),
        release: data?.version || `${opts.from}→${opts.to}`,
        environment,
        action: 'applied',
        target: 'mach',
        key: component,
        detail: `webapp ${result.oldValue ?? '(none)'} → ${result.newValue} from Vercel (${opts.from})`,
        actor: this.context.globalState.get<string>('userEmail') || undefined,
      });

      this.post(MESSAGE_TYPES.INJECT_WEBAPP_VERSION_RESPONSE, {
        ok: true,
        changed: true,
        component,
        version: deployed.version,
        oldValue: result.oldValue,
        newValue: result.newValue,
        commitMessage: deployed.commitMessage,
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

  /**
   * Discover-and-select for the mach repo topology: list GitHub orgs / repos /
   * workflows / branches the mach PAT can see, so the Settings dropdowns are
   * populated from live data instead of asking the user to type ids. One endpoint
   * keyed by `kind`; the UI passes `owner`/`repo` as the selection narrows.
   */
  private async handleDiscoverGithub(data: any): Promise<void> {
    const kind: string = data?.kind ?? '';
    const reply = (payload: any) =>
      this.post(MESSAGE_TYPES.DISCOVER_GITHUB_RESPONSE, { kind, owner: data?.owner, repo: data?.repo, ...payload });

    try {
      if (!(await this.machAuth.isConnected())) return reply({ ok: false, error: 'Set the mach GitHub token first.' });
      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const dep = settings?.state?.config?.deployment ?? {};
      const apiBase: string =
        this.actionConfig(dep, 'github-workflow-dispatch').repo?.apiBase || GITHUB_API_BASE;
      const token = await this.machAuth.requireToken();
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'workspacegpt',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const getJson = async (url: string): Promise<any> => {
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 150)}`);
        return res.json();
      };
      // Follow `Link: rel="next"` and concatenate every page, so a repo/branch/
      // workflow past the first 100 isn't silently dropped from the dropdown.
      // `extract` pulls the array out of object-shaped responses (e.g. workflows).
      // Capped so a pathologically large org can't spin forever; the cap is high
      // enough (25 × 100 = 2500) that hitting it is itself worth surfacing.
      const nextPageUrl = (link: string | null): string | null => {
        if (!link) return null;
        for (const part of link.split(',')) {
          const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
          if (m) return m[1];
        }
        return null;
      };
      const getAllPages = async (
        url: string,
        extract: (body: any) => any[] = (b) => b,
      ): Promise<{ items: any[]; truncated: boolean }> => {
        const out: any[] = [];
        let next: string | null = url;
        let pages = 0;
        while (next && pages < 25) {
          const res: Response = await fetch(next, { headers });
          if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 150)}`);
          const body = await res.json();
          const arr = extract(body);
          if (Array.isArray(arr)) out.push(...arr);
          next = nextPageUrl(res.headers.get('link'));
          pages++;
        }
        return { items: out, truncated: next !== null };
      };

      if (kind === 'orgs') {
        const [me, orgs] = await Promise.all([
          getJson(`${apiBase}/user`),
          getAllPages(`${apiBase}/user/orgs?per_page=100`),
        ]);
        const logins = [me?.login, ...orgs.items.map((o: any) => o?.login)].filter(Boolean);
        return reply({ ok: true, items: Array.from(new Set(logins)) });
      }

      if (kind === 'repos') {
        const owner: string = data?.owner ?? '';
        if (!owner) return reply({ ok: false, error: 'No owner.' });
        // Prefer the org endpoint — it includes the PRIVATE repos the PAT can see
        // (which is usually exactly the monorepo we're after). Only fall back to
        // the user-repos endpoint when the owner genuinely isn't an org (404):
        // that endpoint returns PUBLIC repos only, so falling back on any other
        // error would silently hide the private repo behind a public-only list.
        let repos: { items: any[]; truncated: boolean };
        try {
          repos = await getAllPages(`${apiBase}/orgs/${owner}/repos?per_page=100&type=all&sort=full_name`);
        } catch (e) {
          if (e instanceof Error && /GitHub API 404/.test(e.message)) {
            repos = await getAllPages(`${apiBase}/users/${owner}/repos?per_page=100&sort=full_name`);
          } else {
            throw e;
          }
        }
        return reply({
          ok: true,
          items: repos.items.map((r: any) => r?.name).filter(Boolean),
          truncated: repos.truncated,
        });
      }

      if (kind === 'workflows') {
        const { owner, repo } = data ?? {};
        if (!owner || !repo) return reply({ ok: false, error: 'No owner/repo.' });
        const wf = await getAllPages(
          `${apiBase}/repos/${owner}/${repo}/actions/workflows?per_page=100`,
          (b) => b?.workflows ?? [],
        );
        return reply({ ok: true, items: wf.items.map((w: any) => w?.name).filter(Boolean), truncated: wf.truncated });
      }

      if (kind === 'branches') {
        const { owner, repo } = data ?? {};
        if (!owner || !repo) return reply({ ok: false, error: 'No owner/repo.' });
        const branches = await getAllPages(`${apiBase}/repos/${owner}/${repo}/branches?per_page=100`);
        return reply({ ok: true, items: branches.items.map((b: any) => b?.name).filter(Boolean), truncated: branches.truncated });
      }

      return reply({ ok: false, error: `Unknown discovery kind: ${kind}` });
    } catch (error) {
      reply({ ok: false, error: errMessage(error) });
    }
  }

  /**
   * Detect the roster page's column headers (+ a best-guess mapping) so the
   * column-mapping dropdowns are populated from the real page rather than the
   * user typing header names. Read-only.
   */
  private async handleDiscoverRosterColumns(): Promise<void> {
    const reply = (payload: any) =>
      this.post(MESSAGE_TYPES.DISCOVER_ROSTER_COLUMNS_RESPONSE, payload);
    try {
      const connected =
        (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();
      if (!connected) return reply({ ok: false, error: 'Connect Confluence first.' });
      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const dep = settings?.state?.config?.deployment ?? {};
      if (!this.sourceConfig(dep).rosterPageUrl) {
        return reply({ ok: false, error: 'Set the Release Roster page URL first.' });
      }

      const { headers, guess } = await this.buildConfluenceSource(dep).describeRoster();
      reply({ ok: true, headers, guess });
    } catch (error) {
      reply({ ok: false, error: errMessage(error) });
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
    const status = await this.machAuth.validate(...this.machValidateArgs());
    this.post(MESSAGE_TYPES.MACH_TOKEN_STATUS, { ...status });
  }

  /** The configured repo/brand/sample-env + mode to validate the PAT against. */
  private machValidateArgs(): [MachRepoConfig, string, string, boolean] {
    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const dep = settings?.state?.config?.deployment ?? {};
    const m = this.actionConfig(dep, 'github-workflow-dispatch');
    const repo: MachRepoConfig = { ...EMPTY_MACH_REPO, ...(m.repo ?? {}) };
    return [repo, m.brand || '', m.envStage || 'stage', m.machMode !== false];
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

    const m = this.actionConfig(dep, 'github-workflow-dispatch');
    const machMode: boolean = m.machMode !== false;
    // Repo topology from the action config; blank until the user configures it in Settings.
    const repo: MachRepoConfig = { ...EMPTY_MACH_REPO, ...(m.repo ?? {}) };

    // Generic workflow_dispatch: no promotion semantics — just the workflow and
    // the user's raw inputs. Source-env / dest-env / components.yml don't apply.
    if (!machMode) {
      if (!repo.monorepoOwner || !repo.monorepoRepo || !repo.workflowName) {
        throw new Error('Set the repo owner, repo, and workflow in Settings → Deployment Automation.');
      }
      const inputs: Record<string, string> = { ...toInputRecord(m.inputs), ...(overrides.inputs ?? {}) };
      const opts: MachSyncOptions = {
        repo,
        brand: '',
        from: '',
        to: environment,
        fromBranch: repo.monorepoRef || 'main',
        updateMainYml: false,
        machMode: false,
        inputs,
      };
      return { target: new MachSyncTarget(this.machAuth, opts), opts };
    }

    const brand: string = overrides.brand || m.brand || '';
    const from: string = overrides.from || m.sourceEnv || '';
    if (!from) {
      throw new Error('Set the mach source environment (e.g. test01) in Settings → Deployment Automation.');
    }
    const to: string =
      overrides.to || (environment === 'prod' ? m.envProd || 'prod' : m.envStage || 'stage');
    const fromBranch: string = overrides.fromBranch || m.fromBranch || 'main';
    const updateMainYml: boolean =
      typeof overrides.updateMainYml === 'boolean'
        ? overrides.updateMainYml
        : m.updateMainYml !== false;
    // Per-env policy, defaulting to never auto-merge (safe default).
    const autoMerge: boolean = this.resolveEnv(dep, environment).autoMerge === true;

    const opts: MachSyncOptions = { repo, brand, from, to, fromBranch, updateMainYml, autoMerge, machMode: true };
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
      // Generic dispatch has no component diff — the plan is just "dispatch this
      // workflow with these inputs". MACH mode computes the components.yml delta.
      if (opts.machMode === false) {
        this.post(MESSAGE_TYPES.PLAN_MACH_SYNC_RESPONSE, {
          ok: true,
          environment,
          machMode: false,
          workflow: opts.repo.workflowName,
          ref: opts.repo.monorepoRef,
          inputs: opts.inputs ?? {},
          changes: [],
        });
        return;
      }
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
      const { workflowId, run } = await target.dispatchSync(at);

      const actor = this.context.globalState.get<string>('userEmail') || undefined;
      await this.auditLog().record({
        at,
        release: version || `${opts.from}→${opts.to}`,
        environment,
        action: 'applied',
        target: 'mach',
        actor,
        detail: `dispatched sync ${opts.from}→${opts.to}${run ? ` (run ${run.runId})` : ''}`,
      });

      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const dep = settings?.state?.config?.deployment ?? {};
      const m = this.actionConfig(dep, 'github-workflow-dispatch');
      const postPr = opts.machMode !== false
        ? {
            renameTitle: m.renamePrTitle !== false,
            versionInjection: m.versionInjection?.enabled
              ? { component: m.versionInjection.component || 'webapp', vercelProjectId: m.versionInjection.vercelProjectId || '' }
              : null,
          }
        : null;

      this.post(MESSAGE_TYPES.APPLY_MACH_SYNC_RESPONSE, {
        ok: true,
        environment,
        from: opts.from,
        to: opts.to,
        brand: opts.brand,
        version,
        workflowId,
        dispatchedAt: at,
        run,
        postPr,
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
      const workflowId: number | undefined = data?.workflowId;
      const dispatchedAt: string | undefined = data?.dispatchedAt;
      const environment: string = data?.environment || 'stage';
      const releaseTitle: string | undefined = data?.version;
      if (!runId && !dispatchedAt) return fail('Nothing to check yet.');
      const { target, opts } = await this.buildMachTarget(environment, data?.overrides);

      const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
      const dep = settings?.state?.config?.deployment ?? {};
      const m = this.actionConfig(dep, 'github-workflow-dispatch');
      const renameEnabled = opts.machMode !== false && m.renamePrTitle !== false;

      // Once we have a run id, query it directly; until then, keep trying to
      // locate the run created by our dispatch (the 204 gives us no id).
      const run = runId
        ? await target.getRunStatus(runId)
        : await target.findRun(workflowId, dispatchedAt!);
      let pr = run ? await target.findPullRequest(run.runId) : null;

      // Rename the PR to the release version (e.g. web-2026-6.2-rc.8) once it
      // exists, when the pipeline is configured to do so. Idempotent: only
      // patch when the title actually differs.
      if (pr && renameEnabled && releaseTitle && pr.title !== releaseTitle) {
        try {
          await target.updatePullRequestTitle(pr.number, releaseTitle);
          pr = { ...pr, title: releaseTitle };
        } catch {
          /* non-fatal — leave the workflow's default title */
        }
      }

      this.post(MESSAGE_TYPES.CHECK_MACH_RUN_RESPONSE, { ok: true, run: run ?? null, pr });
    } catch (error) {
      fail(errMessage(error));
    }
  }

  /**
   * Shared read-only plan builder for the mach env-var half: parse the desired
   * mach vars from the release source, read `main.yml` **at the head of the open
   * sync PR** (not the default branch), and diff. Used by both plan (preview) and
   * apply. Throws {@link NoSyncPrError} when no sync PR is open — callers turn
   * that into a "run mach sync first" prompt rather than a hard error.
   */
  private async buildMachEnvPlan(version: string, environment: string, overrides: any = {}) {
    const connected =
      (await this.confluenceAuth.isAuthenticated()) && !!this.confluenceAuth.getStoredSite();
    if (!connected) throw new Error('Connect Confluence (Settings → Confluence) first.');

    const settings: any = this.context.globalState.get(STORAGE_KEYS.SETTINGS);
    const dep = settings?.state?.config?.deployment ?? {};
    const m = this.actionConfig(dep, 'github-workflow-dispatch');

    const { target: sync, opts } = await this.buildMachTarget(environment, overrides);
    const filePath: string = m.mainYmlPath || 'main.yml';
    const target = new MachEnvTarget(sync, { filePath, codec: defaultMainYmlCodec });

    const source = this.buildReleaseSource(dep);
    const desired = await source.fetchDesiredConfig(version, environment);
    const machDesired = desired.filter((v) => v.target === 'mach');

    // readCurrent resolves the sync PR — throws NoSyncPrError if none is open.
    const pr = await target.pullRequest();
    const plan = await buildPlan({
      release: version,
      environment,
      desired: machDesired,
      targets: [target],
      now: new Date().toISOString(),
      source: `mach ${filePath} · PR #${pr.number} (${opts.to})`,
    });

    return { plan, target, pr, filePath };
  }

  /**
   * Read-only preview of the mach env-var sync: diff the release's desired mach
   * vars against `main.yml` on the open sync PR branch. Writes nothing. Reports
   * `needsSync: true` (instead of a hard error) when no sync PR is open yet.
   */
  private async handlePlanMachEnv(data: any): Promise<void> {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      this.post(MESSAGE_TYPES.PLAN_MACH_ENV_RESPONSE, { ok: false, error, ...extra });
    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      if (!version) return fail('No release version to plan. Resolve a release first.');

      const { plan, pr, filePath } = await this.buildMachEnvPlan(version, environment, data?.overrides);
      this.post(MESSAGE_TYPES.PLAN_MACH_ENV_RESPONSE, {
        ok: true,
        version,
        environment,
        filePath,
        pr,
        plan,
      });
    } catch (error) {
      if (error instanceof NoSyncPrError) return fail(errMessage(error), { needsSync: true });
      fail(errMessage(error));
    }
  }

  /**
   * Apply the approved mach env-var changes by committing them to the open sync
   * PR branch (one idempotent commit). Recomputes the plan server-side (never
   * trusts the client diff), refuses on unresolved conflicts, applies only
   * add/update rows — optionally narrowed to `keys` (Retry failed). Every outcome
   * is written to the audit log.
   */
  private async handleApplyMachEnv(data: any): Promise<void> {
    const fail = (error: string, extra: Record<string, unknown> = {}) =>
      this.post(MESSAGE_TYPES.APPLY_MACH_ENV_RESPONSE, { ok: false, error, ...extra });
    try {
      const version: string | undefined = data?.version;
      const environment: string = data?.environment || 'stage';
      const onlyKeys: string[] | undefined = Array.isArray(data?.keys) ? data.keys : undefined;
      if (!version) return fail('No release version to apply.');

      const { plan, target, pr } = await this.buildMachEnvPlan(version, environment, data?.overrides);

      if (hasUnresolvedConflicts(plan.configVars)) {
        return fail('Plan has unresolved conflicts — resolve them before applying.');
      }

      let changes: ConfigVarDiff[] = applicableChanges(plan.configVars);
      if (onlyKeys) changes = changes.filter((c) => onlyKeys.includes(c.key));
      if (changes.length === 0) {
        return this.post(MESSAGE_TYPES.APPLY_MACH_ENV_RESPONSE, {
          ok: true,
          results: [],
          summary: { applied: 0, failed: 0, total: 0 },
          version,
          environment,
          pr,
        });
      }

      const results = await target.apply(environment, changes);
      const applied = results.filter((r) => r.status === 'applied').length;
      const failed = results.filter((r) => r.status === 'failed').length;

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
            detail: r.error ?? (r.reference ? `committed to ${r.reference}` : undefined),
            actor,
          }),
        ),
      );
      await audit.record({
        at,
        release: version,
        environment,
        action: failed > 0 ? 'failed' : 'applied',
        target: 'mach',
        actor,
        detail: `main.yml: ${applied}/${results.length} committed to PR #${pr.number}${failed ? `, ${failed} failed` : ''}`,
      });

      this.post(MESSAGE_TYPES.APPLY_MACH_ENV_RESPONSE, {
        ok: true,
        results,
        summary: { applied, failed, total: results.length },
        version,
        environment,
        pr,
      });
    } catch (error) {
      if (error instanceof NoSyncPrError) return fail(errMessage(error), { needsSync: true });
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
      const status = await this.machAuth.validate(...this.machValidateArgs());
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

/**
 * Normalize the UI's workflow-inputs editor (an array of `{key, value}` rows,
 * or already an object) into the `{ [key]: value }` map GitHub expects. Blank
 * keys are dropped so an empty trailing row doesn't dispatch a `"": ""` input.
 */
function toInputRecord(inputs: unknown): Record<string, string> {
  if (Array.isArray(inputs)) {
    const out: Record<string, string> = {};
    for (const row of inputs) {
      const key = String(row?.key ?? '').trim();
      if (key) out[key] = String(row?.value ?? '');
    }
    return out;
  }
  if (inputs && typeof inputs === 'object') {
    return Object.fromEntries(
      Object.entries(inputs as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
    );
  }
  return {};
}
