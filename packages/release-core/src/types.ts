/**
 * release-core — organisation-agnostic types.
 *
 * The engine only ever knows these generic concepts: release, environment,
 * config variable, target, diff, apply. Anything organisation-specific
 * (Confluence table layouts, Vercel/mach APIs, org-specific tag formats) lives
 * behind the adapter interfaces below — never in these types.
 *
 * See DEPLOYMENT-AUTOMATION-DESIGN.md (repo root) for the full design.
 */

/**
 * A deployment environment. `stage` and `prod` are the common cases, but this
 * is deliberately an open string so other orgs can model `dev`, `qa`, etc.
 */
export type Environment = 'stage' | 'prod' | (string & {});

/** Identifier for a config target system, e.g. `vercel` or `mach`. */
export type ConfigTargetId = string;

/**
 * The classification of a single config variable once desired state has been
 * diffed against live state.
 *
 * - `add`      — not present in the target; will be created.
 * - `match`    — present and already equal to desired; no-op.
 * - `update`   — present with a different value; will be changed.
 * - `conflict` — needs explicit human acknowledgement before applying (e.g. a
 *                value flagged sensitive, or one a policy deems risky to
 *                overwrite). Never applied silently.
 */
export type ConfigAction = 'add' | 'match' | 'update' | 'conflict';

/**
 * One desired config variable, as produced by a {@link ReleaseSource} from the
 * source of truth (e.g. a Confluence Configurations row). This is desired state
 * only — it has not yet been compared to anything live.
 */
export interface DesiredConfigVar {
  /** The variable/flag name, e.g. `NEXT_PUBLIC_FEATURE_FLAG_GOOGLE_PAY`. */
  key: string;
  /** Which target system this variable belongs to. */
  target: ConfigTargetId;
  /** The desired value for the resolved environment. */
  value: string;
  /**
   * Marks a variable whose overwrite should be escalated to `conflict` rather
   * than applied as a routine `update` (secrets, infra-level vars). Defaults to
   * false (a plain feature flag).
   */
  sensitive?: boolean;
  /** Optional free-text note carried through from the source for the reviewer. */
  note?: string;
}

/** Desired state for one release+environment, before diffing. */
export interface DesiredState {
  release: string;
  environment: Environment;
  vars: DesiredConfigVar[];
}

/** One row of the computed plan: desired vs. live, with an action. */
export interface ConfigVarDiff {
  key: string;
  target: ConfigTargetId;
  /** The live value, or null if the variable does not exist in the target. */
  current: string | null;
  desired: string;
  action: ConfigAction;
  sensitive: boolean;
  note?: string;
}

/** Tallied counts per action — drives the summary chips in the UI. */
export interface PlanSummary {
  add: number;
  update: number;
  match: number;
  conflict: number;
  total: number;
}

/**
 * The normalized, reviewable artifact at the centre of the whole feature.
 * Everything upstream parses *into* it; everything downstream acts *from* it.
 */
export interface ReleasePlan {
  release: string;
  environment: Environment;
  /** ISO-8601 timestamp; stamped by the caller (kept out of pure logic). */
  generatedAt: string;
  /** Human-readable provenance, e.g. the Confluence page URL. */
  source?: string;
  configVars: ConfigVarDiff[];
  summary: PlanSummary;
}

/** Resolution of "what are we releasing today?". */
export interface ResolvedRelease {
  version: string;
  environment: Environment;
  /** Optional extras surfaced in the UI (pilot, date, page URL, …). */
  pilot?: string;
  date?: string;
  pageUrl?: string;
  /**
   * A roster row exists for the target date, but it has no version filled
   * in — `version` is `''` in this case. Not an error: the caller should
   * prompt the user to enter a version or release-page URL manually.
   */
  needsVersion?: boolean;
}

/* ------------------------------------------------------------------ */
/* Adapter interfaces — the seams where org-specific knowledge plugs in */
/* ------------------------------------------------------------------ */

/**
 * Knows where the release truth lives (e.g. Confluence roster + release page).
 * Swap for a YAML-file or Jira implementation without touching the engine.
 */
export interface ReleaseSource {
  /** Resolve the release scheduled for the given date (ISO `YYYY-MM-DD`). */
  resolveRelease(date: string): Promise<ResolvedRelease | null>;
  /**
   * Read the desired config for a resolved release + environment. `pageUrl`,
   * when given, points directly at the release page and bypasses any
   * version-based page lookup (useful when there's no version string yet).
   */
  fetchDesiredConfig(version: string, environment: Environment, pageUrl?: string): Promise<DesiredConfigVar[]>;
}

/** The outcome of applying a single variable. */
export interface ApplyResult {
  key: string;
  target: ConfigTargetId;
  /** `applied` for add/update that succeeded; `skipped` for match/conflict. */
  status: 'applied' | 'skipped' | 'failed';
  /** Present when status is `failed`. */
  error?: string;
  /** Present when the apply produced an out-of-band artifact, e.g. a PR URL. */
  reference?: string;
}

/**
 * Knows how to read and write config for one target system (Vercel, mach repo,
 * Parameter Store, …). The engine treats every target identically.
 */
export interface ConfigTarget {
  readonly id: ConfigTargetId;
  /** Read live values for the environment, keyed by variable name. */
  readCurrent(environment: Environment): Promise<Map<string, string>>;
  /**
   * Apply the approved changes (add/update rows only — the engine filters out
   * match/conflict before calling). Must be idempotent: re-applying a change
   * that is already satisfied is a no-op.
   */
  apply(environment: Environment, changes: ConfigVarDiff[]): Promise<ApplyResult[]>;
}

/* VCS + ticket providers are used by the later hotfix milestone; declared here
 * so the engine surface is stable. See §9 of the design doc. */

export interface CommitRef {
  sha: string;
  title: string;
  component?: string;
}

export interface VcsProvider {
  findCommitsByTicket(ticket: string): Promise<CommitRef[]>;
  cherryPick(branch: string, shas: string[]): Promise<void>;
  createTag(tag: string, ref: string): Promise<void>;
  createRelease(tag: string, name: string): Promise<{ url: string }>;
}

export interface TicketProvider {
  /** Normalise a raw ticket reference (e.g. `D2C-123456`) and confirm it exists. */
  resolveTicket(raw: string): Promise<{ id: string; title: string } | null>;
}

/* ------------------------------------------------------------------ */
/* Pipeline actions — the universal deployment-step interface          */
/* ------------------------------------------------------------------ */

/**
 * The category of a pipeline action. Inspired by the common industry rollout
 * strategies, but deliberately open-ended: only `deploy` is implemented today
 * (config push + triggered promotion). The rest are RESERVED names so the model
 * can be extended to those strategies later without reshaping the core — they
 * carry no implementation yet.
 *
 * - `deploy`      — converge config or trigger a promotion (rolling, recreate,
 *                   GitOps, feature-flag push all reduce to this).
 * - `switch`      — atomic traffic cutover (blue-green). RESERVED.
 * - `progressive` — percentage/bake-window rollout (canary). RESERVED.
 * - `verify`      — health/observability gate. RESERVED.
 * - `rollback`    — revert a prior action. RESERVED.
 */
export type ActionCategory =
  | 'deploy'
  | 'switch'
  | 'progressive'
  | 'verify'
  | 'rollback';

/** A reference to out-of-band work an action started (a PR, a CI run, …). */
export interface ActionRef {
  /** Discriminator, e.g. `github-run`, `pull-request`. */
  kind: string;
  id: string | number;
  url?: string;
  [k: string]: unknown;
}

/** Everything an action needs to plan/apply, supplied by the pipeline runner. */
export interface ActionContext {
  release: string;
  environment: Environment;
  /** ISO-8601 timestamp; injected so action logic stays pure/testable. */
  now: string;
  /** Desired config (convergent actions filter this by their target id). */
  desired?: DesiredConfigVar[];
}

/** A reviewable preview of what an action would do. */
export interface ActionPlan {
  actionId: string;
  category: ActionCategory;
  /** Populated by convergent actions (key/value config diff). */
  plan?: ReleasePlan;
  /** Freeform preview rows for triggered actions (e.g. component-version deltas). */
  preview?: unknown[];
  summary?: string;
}

/** The outcome of applying an action. */
export interface ActionOutcome {
  actionId: string;
  /** `pending` covers triggered actions whose real result arrives via {@link PipelineAction.poll}. */
  status: 'applied' | 'skipped' | 'failed' | 'pending';
  results?: ApplyResult[];
  refs?: ActionRef[];
  error?: string;
}

/**
 * The universal deployment-step interface. Every target — convergent config
 * push (Vercel, SSM, a repo file), a triggered promotion workflow (mach), and
 * any future switch/canary/rollback — implements this, so the runner and UI
 * treat them uniformly. `rollback`/`verify` are optional and unimplemented for
 * the current (Mars) actions; they're the seams the reserved categories use.
 */
export interface PipelineAction {
  readonly id: string;
  readonly category: ActionCategory;
  /** Read-only preview. Convergent actions use `ctx.desired`; triggered ones ignore it. */
  plan(ctx: ActionContext): Promise<ActionPlan>;
  /** Execute approved changes; returns the outcome and any out-of-band refs. */
  apply(ctx: ActionContext, approved?: ConfigVarDiff[]): Promise<ActionOutcome>;
  /** Poll an async/triggered action to completion. Optional. */
  poll?(ref: ActionRef): Promise<ActionOutcome>;
  /** Revert a prior apply. RESERVED — not implemented for current actions. */
  rollback?(ctx: ActionContext, ref?: ActionRef): Promise<ActionOutcome>;
  /** Health/verify gate. RESERVED — not implemented for current actions. */
  verify?(ctx: ActionContext): Promise<{ ok: boolean; detail?: string }>;
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

export interface AuditEntry {
  /** ISO-8601 timestamp; supplied by the caller. */
  at: string;
  release: string;
  environment: Environment;
  action: 'planned' | 'approved' | 'applied' | 'failed' | 'skipped';
  target?: ConfigTargetId;
  key?: string;
  actor?: string;
  detail?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  list(release?: string): Promise<AuditEntry[]>;
}
