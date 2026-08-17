import React, { useEffect, useRef, useState } from 'react';
import './Settings.css';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import SearchableDropdown from './settings/SearchableDropdown';

interface ResolvedRelease {
  configured: boolean;
  date?: string;
  version?: string;
  environment?: string;
  pilot?: string;
  pageUrl?: string;
  /** Why resolution didn't produce a release (shown in the empty state). */
  reason?: string;
  /** A roster row exists for today but has no version filled in. */
  needsVersion?: boolean;
}

interface ReleaseRun {
  release: string;
  environment: string;
  status: 'applied' | 'awaiting' | 'failed' | 'planned';
  at?: string;
}

interface DesiredVar {
  key: string;
  target: string;
  value: string;
  sensitive?: boolean;
  note?: string;
}

interface PreparePreview {
  loading: boolean;
  vars?: DesiredVar[];
  version?: string;
  environment?: string;
  error?: string;
}

type PlanAction = 'add' | 'update' | 'match' | 'conflict';

interface PlanRow {
  key: string;
  target: string;
  current: string | null;
  desired: string;
  action: PlanAction;
  sensitive: boolean;
  note?: string;
  /** Live value couldn't be read (integration token can't decrypt). */
  opaque?: boolean;
  /** Number of environments the live record is linked to (when > 1). */
  linkedEnvs?: number;
  /** Whether this shared var will be split into a per-env record on apply. */
  willSplit?: boolean;
}

interface PlanData {
  release: string;
  environment: string;
  source?: string;
  configVars: PlanRow[];
  summary: { add: number; update: number; match: number; conflict: number; total: number };
}

interface PlanState {
  loading: boolean;
  plan?: PlanData;
  skipped?: { key: string; target: string }[];
  vercelEnv?: string;
  valuesOpaque?: boolean;
  error?: string;
  /** mach env-var plan: no open sync PR to diff against yet — run mach sync first. */
  needsSync?: boolean;
  /** mach env-var plan: the open sync PR being diffed against / committed to. */
  pr?: MachPull;
}

interface ReleasesProps {
  isVisible: boolean;
  onBack: () => void;
}

/**
 * Read-only preview of the desired config parsed from the release page. This is
 * the first half of config-sync: it shows *what the page says* (desired state),
 * grouped by target. It does NOT read live Vercel/mach state or compute a diff —
 * that (and the apply) lands with the ConfigTarget adapters in a later step.
 */
const ConfigPreview: React.FC<{ preview: PreparePreview }> = ({ preview }) => {
  if (preview.error) {
    return (
      <div className="status-message error" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
        {preview.error}
      </div>
    );
  }

  const vars = preview.vars || [];
  if (vars.length === 0) {
    return (
      <div style={{ marginTop: 12, color: '#888', fontSize: '0.88em' }}>
        No config variables found on the release page for {preview.version}.
      </div>
    );
  }

  // Group by target so the eye maps each var to where it would land.
  const groups = vars.reduce<Record<string, DesiredVar[]>>((acc, v) => {
    (acc[v.target] = acc[v.target] || []).push(v);
    return acc;
  }, {});

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: 'inline-block',
          fontSize: '0.72em',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: '#e0a93b',
          border: '1px solid #6b531a',
          background: '#2a2410',
          borderRadius: 6,
          padding: '2px 8px',
          marginBottom: 10,
        }}
      >
        Preview only — nothing read or written
      </div>

      <div style={{ fontSize: '0.85em', color: '#a0a0a0', marginBottom: 10 }}>
        {vars.length} variable{vars.length === 1 ? '' : 's'} for{' '}
        <strong>{preview.version}</strong> · {preview.environment}
      </div>

      <div style={{ fontSize: '0.78em', color: '#888', marginBottom: 10 }}>
        Target looks wrong? Configure it in Settings → Deployment Automation → Config target routing.
      </div>

      {Object.entries(groups).map(([target, items]) => (
        <div key={target} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '0.8em', fontWeight: 600, color: '#85b7eb', marginBottom: 6, textTransform: 'uppercase' }}>
            {target} · {items.length}
          </div>
          {items.map((v, i) => (
            <div
              key={`${v.key}-${i}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 10,
                fontSize: '0.82em',
                padding: '5px 0',
                borderBottom: '1px solid #23233a',
              }}
            >
              <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {v.key}
                {v.sensitive && (
                  <span style={{ marginLeft: 6, color: '#e0a93b', fontSize: '0.85em' }}>🔒</span>
                )}
              </span>
              <span
                style={{
                  color: v.value ? '#a0a0a0' : '#e0a93b',
                  fontFamily: 'monospace',
                  fontStyle: v.value ? 'normal' : 'italic',
                  wordBreak: 'break-all',
                  textAlign: 'right',
                }}
              >
                {v.sensitive ? '••••••' : v.value || `(no value for ${preview.environment})`}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};

const ACTION_COLOR: Record<PlanAction, string> = {
  add: '#4ecca3',
  update: '#e0a93b',
  match: '#6b7280',
  conflict: '#e74c3c',
};

/**
 * Read-only plan: desired config diffed against live Vercel state, terraform-
 * style. Summary chips, rows labelled add/update/match/conflict (match rows
 * de-emphasised), conflicts surfaced. Nothing is applied — the apply gate lands
 * in the next step.
 */
const PlanReview: React.FC<{
  state: PlanState;
  uncheckedKeys: Set<string>;
  onToggle: (key: string) => void;
}> = ({ state, uncheckedKeys, onToggle }) => {
  if (state.error) {
    return (
      <div className="status-message error" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
        {state.error}
      </div>
    );
  }
  if (!state.plan) return null;

  const { summary, configVars } = state.plan;
  const chip = (label: string, n: number, color: string) =>
    n > 0 ? (
      <span key={label} style={{ color, fontSize: '0.8em', marginRight: 10 }}>
        {n} {label}
      </span>
    ) : null;

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: 'inline-block',
          fontSize: '0.72em',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: '#e0a93b',
          border: '1px solid #6b531a',
          background: '#2a2410',
          borderRadius: 6,
          padding: '2px 8px',
          marginBottom: 10,
        }}
      >
        Dry run — nothing applied
      </div>

      <div style={{ marginBottom: 8 }}>
        {chip('add', summary.add, ACTION_COLOR.add)}
        {chip('update', summary.update, ACTION_COLOR.update)}
        {chip('match', summary.match, ACTION_COLOR.match)}
        {chip('conflict', summary.conflict, ACTION_COLOR.conflict)}
      </div>
      {state.plan.source && (
        <div style={{ fontSize: '0.8em', color: '#888', marginBottom: 8 }}>{state.plan.source}</div>
      )}

      {state.valuesOpaque && (
        <div style={{ fontSize: '0.8em', color: '#a0a0a0', lineHeight: 1.5, marginBottom: 8 }}>
          ⚠️ The Vercel integration token can't read existing values, so present variables show as{' '}
          <span style={{ color: ACTION_COLOR.update }}>update</span> and will be set to the desired
          value on apply (existing keys are never missed; matches can't be confirmed).
        </div>
      )}

      {configVars.map((r, i) => {
        const applicable = r.action === 'add' || r.action === 'update';
        const checked = !uncheckedKeys.has(r.key);
        return (
        <div
          key={`${r.key}-${i}`}
          style={{
            padding: '6px 0',
            borderBottom: '1px solid #23233a',
            opacity: r.action === 'match' ? 0.55 : applicable && !checked ? 0.45 : 1,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'monospace', fontSize: '0.82em', wordBreak: 'break-all' }}>
              {applicable && (
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(r.key)}
                  title={checked ? 'Included in apply — uncheck to skip this variable' : 'Excluded from apply'}
                  style={{ flexShrink: 0 }}
                />
              )}
              {r.key}
              {r.sensitive && <span style={{ marginLeft: 6, color: '#e0a93b' }}>🔒</span>}
            </span>
            <span
              style={{
                fontSize: '0.72em',
                textTransform: 'uppercase',
                color: ACTION_COLOR[r.action],
                flexShrink: 0,
              }}
            >
              {r.action}
            </span>
          </div>
          {r.action !== 'match' && (
            <div style={{ fontSize: '0.78em', color: '#a0a0a0', fontFamily: 'monospace', marginTop: 2 }}>
              {r.sensitive
                ? '•••••• → ••••••'
                : `${r.opaque ? '(value hidden)' : r.current === null ? '(none)' : r.current} → ${r.desired || '(empty)'}`}
            </div>
          )}
          {!!r.linkedEnvs && r.linkedEnvs > 1 && (
            <div style={{ fontSize: '0.74em', color: '#e0a93b', marginTop: 2 }}>
              {r.willSplit
                ? `↳ split into a dedicated record (currently linked to ${r.linkedEnvs} environments)`
                : `↳ linked to ${r.linkedEnvs} environments — update changes all of them`}
            </div>
          )}
        </div>
        );
      })}

      {state.skipped && state.skipped.length > 0 && (
        <div style={{ marginTop: 12, fontSize: '0.8em', color: '#888' }}>
          {state.skipped.length} mach variable{state.skipped.length === 1 ? '' : 's'} not applied here
          — handled by the mach main.yml pipeline (③) below:{' '}
          {state.skipped.map((s) => s.key).join(', ')}
        </div>
      )}
    </div>
  );
};

interface ApplyResultRow {
  key: string;
  target: string;
  status: 'applied' | 'skipped' | 'failed';
  error?: string;
  reference?: string;
}

interface ApplyState {
  loading: boolean;
  results?: ApplyResultRow[];
  summary?: { applied: number; failed: number; total: number };
  error?: string;
}

type MachAction = 'update' | 'match' | 'manual' | 'skip';

interface MachChangeRow {
  component: string;
  current: string | null;
  desired: string;
  action: MachAction;
}

interface MachPlanState {
  loading: boolean;
  changes?: MachChangeRow[];
  from?: string;
  to?: string;
  brand?: string;
  updateMainYml?: boolean;
  error?: string;
}

interface MachRun {
  runId: number;
  runUrl: string;
  status: string;
  conclusion?: string | null;
}

interface MachPull {
  url: string;
  number: number;
  state: string;
  merged: boolean;
  title: string;
}

interface MachApplyState {
  loading: boolean;
  run?: MachRun | null;
  pr?: MachPull | null;
  /** Workflow id + dispatch time, used to locate the run before it has an id. */
  workflowId?: number;
  dispatchedAt?: string;
  /** Release version — applied as the PR title once the PR opens. */
  version?: string;
  /** Captured trigger context so polling rebuilds the same target. */
  ctx?: { environment: string; from: string; to: string; brand: string };
  /** Which post-PR steps this pipeline is configured to run — from Settings, not hardcoded. */
  postPr?: { renameTitle: boolean; versionInjection: { component: string; vercelProjectId: string } | null } | null;
  error?: string;
}

const MACH_POLL_SECONDS = 20;

/* ------------------------------- hotfix flow ------------------------------- */

interface HotfixCommitRow {
  sha: string;
  title: string;
  ticket: string;
}
interface HotfixComponentRow {
  component: string;
  commits: HotfixCommitRow[];
  baseVersion?: string;
  hotfixNumber: number;
  /** Null when no base version could be derived — the reviewer must supply one. */
  tag: string | null;
}
interface HotfixPlanData {
  tickets: { id: string; title?: string }[];
  branch: string;
  components: HotfixComponentRow[];
  unassigned: HotfixCommitRow[];
  summary: { tickets: number; commits: number; components: number; unassigned: number };
}
interface HotfixPlanState {
  loading?: boolean;
  error?: string;
  plan?: HotfixPlanData;
}
interface HotfixResultRow {
  component: string;
  tag: string;
  status: 'applied' | 'failed';
  releaseUrl?: string;
  error?: string;
}
interface HotfixApplyState {
  loading?: boolean;
  error?: string;
  branch?: string;
  results?: HotfixResultRow[];
  summary?: { applied: number; failed: number; total: number };
}

const MACH_ACTION_COLOR: Record<MachAction, string> = {
  update: '#e0a93b',
  match: '#6b7280',
  manual: '#85b7eb',
  skip: '#6b7280',
};

/**
 * Read-only preview of the mach component-version promotion: the exact version
 * changes the workflow would write into the destination repo's components.yml.
 * `manual` = new in source (workflow leaves for a human); `skip` = @skipdeploy.
 */
const MachPlanReview: React.FC<{ state: MachPlanState }> = ({ state }) => {
  if (state.error) {
    return (
      <div className="status-message error" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
        {state.error}
      </div>
    );
  }
  if (!state.changes) return null;

  const updates = state.changes.filter((c) => c.action === 'update');
  const manual = state.changes.filter((c) => c.action === 'manual');
  const skipped = state.changes.filter((c) => c.action === 'skip');
  const matched = state.changes.filter((c) => c.action === 'match');

  return (
    <div style={{ marginTop: 14 }}>
      <div
        style={{
          display: 'inline-block', fontSize: '0.72em', textTransform: 'uppercase', letterSpacing: 0.5,
          color: '#e0a93b', border: '1px solid #6b531a', background: '#2a2410',
          borderRadius: 6, padding: '2px 8px', marginBottom: 10,
        }}
      >
        Dry run — nothing dispatched
      </div>

      <div style={{ fontSize: '0.82em', color: '#a0a0a0', marginBottom: 8 }}>
        <strong>{state.from}</strong> → <strong>{state.to}</strong> ({state.brand}) ·{' '}
        <span style={{ color: MACH_ACTION_COLOR.update }}>{updates.length} update</span>
        {manual.length > 0 && <span style={{ color: MACH_ACTION_COLOR.manual, marginLeft: 8 }}>{manual.length} manual</span>}
        {matched.length > 0 && <span style={{ color: '#6b7280', marginLeft: 8 }}>{matched.length} match</span>}
        {skipped.length > 0 && <span style={{ color: '#6b7280', marginLeft: 8 }}>{skipped.length} skip</span>}
      </div>

      {state.changes
        .filter((c) => c.action !== 'match')
        .map((c, i) => (
          <div key={`${c.component}-${i}`} style={{ padding: '6px 0', borderBottom: '1px solid #23233a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontFamily: 'monospace', fontSize: '0.82em', wordBreak: 'break-all' }}>
                {c.component}
              </span>
              <span style={{ fontSize: '0.72em', textTransform: 'uppercase', color: MACH_ACTION_COLOR[c.action], flexShrink: 0 }}>
                {c.action}
              </span>
            </div>
            {c.action === 'update' && (
              <div style={{ fontSize: '0.78em', color: '#a0a0a0', fontFamily: 'monospace', marginTop: 2 }}>
                {c.current ?? '(none)'} → {c.desired}
              </div>
            )}
            {c.action === 'manual' && (
              <div style={{ fontSize: '0.74em', color: '#85b7eb', marginTop: 2 }}>
                ↳ new in {state.from} ({c.desired}) — add to {state.to} manually; not in the PR
              </div>
            )}
          </div>
        ))}

      {updates.length === 0 && manual.length === 0 && (
        <div style={{ fontSize: '0.82em', color: '#888', marginTop: 6 }}>
          Component versions already match — the workflow would produce an empty PR.
        </div>
      )}
      {state.updateMainYml && (
        <div style={{ fontSize: '0.76em', color: '#888', marginTop: 8 }}>
          main.yml env-var sync runs as its own step (③ below), diffed against this PR.
        </div>
      )}
    </div>
  );
};

/**
 * Distinct accent per deployment pipeline, so a button's colour tells you which
 * target it acts on. Chosen to avoid the semantic colours (green=done,
 * red=fail, amber=warn) used by status glyphs.
 */
const PIPE = {
  vercel: '#4f9cf9', // frontend config
  machComp: '#a78bfa', // backend component versions
  machEnv: '#22d3ee', // backend main.yml env vars
  hotfix: '#e879c9', // hotfix cherry-pick → tag → release
} as const;

type StepState = 'pending' | 'active' | 'done' | 'error' | 'blocked';

const STEP_LABEL_COLOR: Record<StepState, string> = {
  done: '#4ecca3',
  active: '', // falls back to the pipeline accent
  error: '#e74c3c',
  blocked: '#e0a93b',
  pending: '#6b7280',
};

/** Status dot for one pipeline step. */
const StepDot: React.FC<{ state: StepState; accent: string }> = ({ state, accent }) => {
  const base: React.CSSProperties = {
    width: 15,
    height: 15,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    fontWeight: 700,
    flexShrink: 0,
    lineHeight: 1,
    boxSizing: 'border-box',
  };
  if (state === 'done') return <span style={{ ...base, background: '#4ecca3', color: '#0b0b14' }}>✓</span>;
  if (state === 'error') return <span style={{ ...base, background: '#e74c3c', color: '#fff' }}>!</span>;
  if (state === 'blocked') return <span style={{ ...base, background: '#e0a93b', color: '#0b0b14' }}>!</span>;
  if (state === 'active') return <span style={{ ...base, background: accent, color: '#0b0b14' }}>●</span>;
  return <span style={{ ...base, border: '1.5px solid #4b4b63' }} />;
};

/** Accent-tinted primary-button style, so the colour maps to the pipeline. */
const pipeBtn = (accent: string): React.CSSProperties => ({
  marginTop: 12,
  width: '100%',
  background: accent,
  borderColor: accent,
  color: '#0b0b14',
  fontWeight: 600,
});

/**
 * A visually distinct card for one deployment pipeline. The accent bar +
 * numbered header separate it from its siblings; the step tracker shows at a
 * glance which step you're on and what's already done.
 */
const PipelineCard: React.FC<{
  accent: string;
  index: number;
  title: string;
  target: string;
  steps: { label: string; state: StepState }[];
  dependsOn?: string;
  children: React.ReactNode;
}> = ({ accent, index, title, target, steps, dependsOn, children }) => (
  <div
    style={{
      marginTop: 18,
      borderRadius: 10,
      border: `1px solid ${accent}33`,
      borderLeft: `3px solid ${accent}`,
      background: `${accent}0d`,
      padding: '14px 16px',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: accent,
          color: '#0b0b14',
          fontSize: '0.72em',
          fontWeight: 700,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {index}
      </span>
      <span style={{ fontWeight: 600, color: accent, fontSize: '0.92em' }}>{title}</span>
      <span style={{ fontSize: '0.68em', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {target}
      </span>
    </div>

    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '9px 0 12px', flexWrap: 'wrap' }}>
      {steps.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: '#3a3a52', fontSize: '0.8em' }}>›</span>}
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: '0.75em',
              color: STEP_LABEL_COLOR[s.state] || accent,
            }}
          >
            <StepDot state={s.state} accent={accent} />
            {s.label}
          </span>
        </React.Fragment>
      ))}
    </div>

    {dependsOn && <div style={{ fontSize: '0.74em', color: '#e0a93b', marginBottom: 10 }}>↳ {dependsOn}</div>}

    {children}
  </div>
);

/**
 * Releases home (sidebar overlay). Resolves "today's release" and lists recent
 * runs. The resolve/runs data comes from the extension; until a release source
 * and the apply flow exist (later milestones), it renders empty states rather
 * than fabricated data.
 */
const Releases: React.FC<ReleasesProps> = ({ isVisible, onBack }) => {
  const vscode = VSCodeAPI();
  const [release, setRelease] = useState<ResolvedRelease | null>(null);
  const [runs, setRuns] = useState<ReleaseRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreparePreview | null>(null);
  const [plan, setPlan] = useState<PlanState | null>(null);
  // Keys the user unchecked in the plan review — everything is checked (synced)
  // by default; unchecking excludes that one var from apply. Reset whenever a
  // fresh plan comes back so a re-plan starts from all-checked again.
  const [uncheckedPlanKeys, setUncheckedPlanKeys] = useState<Set<string>>(new Set());
  const [uncheckedMachEnvKeys, setUncheckedMachEnvKeys] = useState<Set<string>>(new Set());
  const [apply, setApply] = useState<ApplyState | null>(null);
  const [machPlan, setMachPlan] = useState<MachPlanState | null>(null);
  const [machApply, setMachApply] = useState<MachApplyState | null>(null);
  const [machEnvPlan, setMachEnvPlan] = useState<PlanState | null>(null);
  const [machEnvApply, setMachEnvApply] = useState<ApplyState | null>(null);
  const [machCountdown, setMachCountdown] = useState(MACH_POLL_SECONDS);
  const [machWebapp, setMachWebapp] = useState<{
    loading?: boolean;
    done?: boolean;
    changed?: boolean;
    version?: string;
    oldValue?: string;
    newValue?: string;
    error?: string;
  } | null>(null);
  // Latest apply state, so the poll interval reads current ids without resubscribing.
  const machApplyRef = useRef<MachApplyState | null>(null);
  machApplyRef.current = machApply;
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideMode, setOverrideMode] = useState<'version' | 'pageUrl'>('version');
  const [overrideVersion, setOverrideVersion] = useState('');
  const [overridePageUrl, setOverridePageUrl] = useState('');
  const [overrideEnv, setOverrideEnv] = useState('stage');
  // Whether the user has explicitly touched the Env dropdown — distinct from
  // hasOverride (version/page URL), so switching just the env takes effect
  // immediately instead of silently falling back to the resolved release's env.
  const [envTouched, setEnvTouched] = useState(false);
  // Hotfix flow state.
  const [hotfixTickets, setHotfixTickets] = useState('');
  const [hotfixBase, setHotfixBase] = useState<Record<string, string>>({});
  const [hotfixPlan, setHotfixPlan] = useState<HotfixPlanState | null>(null);
  const [hotfixApply, setHotfixApply] = useState<HotfixApplyState | null>(null);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case MESSAGE_TYPES.RESOLVE_RELEASE_RESPONSE:
          setRelease({
            configured: !!message.configured,
            date: message.date,
            version: message.version,
            environment: message.environment,
            pilot: message.pilot,
            pageUrl: message.pageUrl,
            reason: message.reason,
            needsVersion: !!message.needsVersion,
          });
          // Seed the editable version field from the resolved value so the
          // displayed version is always correctable in place (the roster
          // source can produce garbled/duplicated text).
          setOverrideVersion(message.version || '');
          if (message.needsVersion) {
            setOverrideOpen(true);
            if (message.environment) setOverrideEnv(message.environment);
          }
          setLoading(false);
          break;
        case MESSAGE_TYPES.GET_RELEASE_RUNS_RESPONSE:
          setRuns(message.runs || []);
          break;
        case MESSAGE_TYPES.PREPARE_CONFIG_SYNC_RESPONSE:
          setPreview(
            message.ok
              ? {
                  loading: false,
                  vars: message.vars || [],
                  version: message.version,
                  environment: message.environment,
                }
              : { loading: false, error: message.error || 'Failed to prepare config sync.' }
          );
          break;
        case MESSAGE_TYPES.PLAN_CONFIG_SYNC_RESPONSE:
          setPlan(
            message.ok
              ? {
                  loading: false,
                  plan: message.plan,
                  skipped: message.skipped || [],
                  vercelEnv: message.vercelEnv,
                  valuesOpaque: message.valuesOpaque,
                }
              : { loading: false, error: message.error || 'Failed to compute plan.' }
          );
          setUncheckedPlanKeys(new Set());
          break;
        case MESSAGE_TYPES.APPLY_CONFIG_SYNC_RESPONSE:
          setApply(
            message.ok
              ? { loading: false, results: message.results || [], summary: message.summary }
              : { loading: false, error: message.error || 'Apply failed.' }
          );
          // Refresh the runs list so the new run appears.
          vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
          break;
        case MESSAGE_TYPES.PLAN_MACH_SYNC_RESPONSE:
          setMachPlan(
            message.ok
              ? {
                  loading: false,
                  changes: message.changes || [],
                  from: message.from,
                  to: message.to,
                  brand: message.brand,
                  updateMainYml: message.updateMainYml,
                }
              : { loading: false, error: message.error || 'Failed to plan mach sync.' }
          );
          break;
        case MESSAGE_TYPES.APPLY_MACH_SYNC_RESPONSE:
          if (message.ok) {
            setMachApply({
              loading: false,
              run: message.run ?? null,
              pr: null,
              workflowId: message.workflowId,
              dispatchedAt: message.dispatchedAt,
              version: message.version,
              ctx: {
                environment: message.environment,
                from: message.from,
                to: message.to,
                brand: message.brand || '',
              },
              postPr: message.postPr ?? null,
            });
          } else {
            setMachApply({ loading: false, error: message.error || 'Dispatch failed.' });
          }
          vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
          break;
        case MESSAGE_TYPES.CHECK_MACH_RUN_RESPONSE:
          if (message.ok) {
            setMachApply((prev) =>
              prev ? { ...prev, run: message.run || prev.run, pr: message.pr ?? prev.pr } : prev
            );
          }
          break;
        case MESSAGE_TYPES.PLAN_MACH_ENV_RESPONSE:
          setMachEnvPlan(
            message.ok
              ? { loading: false, plan: message.plan, pr: message.pr }
              : {
                  loading: false,
                  error: message.error || 'Failed to plan mach env vars.',
                  needsSync: !!message.needsSync,
                }
          );
          setUncheckedMachEnvKeys(new Set());
          break;
        case MESSAGE_TYPES.APPLY_MACH_ENV_RESPONSE:
          setMachEnvApply(
            message.ok
              ? { loading: false, results: message.results || [], summary: message.summary }
              : { loading: false, error: message.error || 'Apply failed.' }
          );
          vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
          break;
        case MESSAGE_TYPES.INJECT_WEBAPP_VERSION_RESPONSE:
          setMachWebapp(
            message.ok
              ? {
                  loading: false,
                  done: true,
                  changed: !!message.changed,
                  version: message.version,
                  oldValue: message.oldValue,
                  newValue: message.newValue,
                }
              : { loading: false, error: message.error || 'Failed to set webapp version.' }
          );
          break;
        case MESSAGE_TYPES.PLAN_HOTFIX_RESPONSE:
          setHotfixPlan(message.ok ? { plan: message.plan } : { error: message.error });
          break;
        case MESSAGE_TYPES.APPLY_HOTFIX_RESPONSE:
          setHotfixApply(
            message.ok
              ? { results: message.results, summary: message.summary, branch: message.branch }
              : { error: message.error }
          );
          if (message.ok) vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Re-resolve "today's release" and refresh the runs list whenever the panel is
  // reopened, but leave any in-progress preview/plan/apply/mach state alone —
  // switching views/windows and coming back shouldn't discard a release run.
  useEffect(() => {
    if (isVisible) {
      setLoading(true);
      vscode.postMessage({ type: MESSAGE_TYPES.RESOLVE_RELEASE });
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
    }
  }, [isVisible]);

  // One status check: query by run id once known, else locate the run from the
  // dispatch. Reads the ref so it stays current inside the interval closure.
  const sendMachCheck = () => {
    const m = machApplyRef.current;
    if (!m || m.error) return;
    vscode.postMessage({
      type: MESSAGE_TYPES.CHECK_MACH_RUN,
      runId: m.run?.runId,
      workflowId: m.workflowId,
      dispatchedAt: m.dispatchedAt,
      version: m.version,
      environment: m.ctx?.environment || 'stage',
      overrides: m.ctx ? { from: m.ctx.from, to: m.ctx.to, brand: m.ctx.brand } : undefined,
    });
  };

  const recheckMach = () => {
    setMachCountdown(MACH_POLL_SECONDS);
    sendMachCheck();
  };

  // Poll a triggered mach run until its PR appears or the run completes (~5 min),
  // ticking a 1s countdown so the user sees when the next check fires.
  const machRunCompleted = machApply?.run?.status === 'completed';
  // Keep polling until the RUN finishes (not just until the PR appears) — the PR
  // is created a few seconds before the run flips to `completed`, so stopping on
  // the PR would freeze the status display at `in_progress`.
  const machPollActive =
    !!machApply && !machApply.loading && !machApply.error && !machRunCompleted;
  const machRunId = machApply?.run?.runId;
  useEffect(() => {
    if (!machPollActive) return;
    setMachCountdown(MACH_POLL_SECONDS);
    sendMachCheck(); // check straight away (the run may already be queryable)
    const id = setInterval(() => {
      setMachCountdown((c) => {
        if (c <= 1) {
          sendMachCheck();
          return MACH_POLL_SECONDS;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [machPollActive, machRunId]);

  if (!isVisible) return null;

  // The override (when set) wins over the resolved release — used both to
  // test config-sync against an arbitrary version/env, and to fill in a
  // version/page URL manually when the roster row is missing one.
  const overridePageUrlTrimmed = overridePageUrl.trim();
  const hasOverride = overrideVersion.trim().length > 0 || overridePageUrlTrimmed.length > 0;
  const effectiveVersion = hasOverride ? overrideVersion.trim() : release?.version;
  const effectivePageUrl = hasOverride ? overridePageUrlTrimmed : release?.pageUrl;
  const effectiveEnv = hasOverride || envTouched ? overrideEnv : release?.environment;
  const canPrepare = !!release?.configured || hasOverride;

  const prepareConfigSync = () => {
    if (!effectiveVersion && !effectivePageUrl) return;
    setPreview({ loading: true });
    setPlan(null);
    setApply(null);
    vscode.postMessage({
      type: MESSAGE_TYPES.PREPARE_CONFIG_SYNC,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
      pageUrl: effectivePageUrl || undefined,
    });
  };

  const planConfigSync = () => {
    if (!effectiveVersion) return;
    setPlan({ loading: true });
    setApply(null);
    vscode.postMessage({
      type: MESSAGE_TYPES.PLAN_CONFIG_SYNC,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
    });
  };

  const applyConfigSync = (keys?: string[]) => {
    if (!effectiveVersion) return;
    setApply({ loading: true });
    vscode.postMessage({
      type: MESSAGE_TYPES.APPLY_CONFIG_SYNC,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
      ...(keys ? { keys } : {}),
    });
  };

  const planMachSync = () => {
    setMachPlan({ loading: true });
    setMachApply(null);
    vscode.postMessage({
      type: MESSAGE_TYPES.PLAN_MACH_SYNC,
      environment: effectiveEnv || 'stage',
    });
  };

  const applyMachSync = () => {
    setMachApply({ loading: true });
    vscode.postMessage({
      type: MESSAGE_TYPES.APPLY_MACH_SYNC,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
    });
  };

  const injectWebappVersion = () => {
    const m = machApplyRef.current;
    if (!m?.run?.runId || !m.postPr?.versionInjection) return;
    setMachWebapp({ loading: true });
    vscode.postMessage({
      type: MESSAGE_TYPES.INJECT_WEBAPP_VERSION,
      runId: m.run.runId,
      version: m.version,
      component: m.postPr.versionInjection.component,
      environment: m.ctx?.environment || 'stage',
      overrides: m.ctx ? { from: m.ctx.from, to: m.ctx.to, brand: m.ctx.brand } : undefined,
    });
  };

  const planMachEnv = () => {
    if (!effectiveVersion) return;
    setMachEnvPlan({ loading: true });
    setMachEnvApply(null);
    vscode.postMessage({
      type: MESSAGE_TYPES.PLAN_MACH_ENV,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
    });
  };

  const applyMachEnv = (keys?: string[]) => {
    if (!effectiveVersion) return;
    setMachEnvApply({ loading: true });
    vscode.postMessage({
      type: MESSAGE_TYPES.APPLY_MACH_ENV,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
      ...(keys ? { keys } : {}),
    });
  };

  const parseTickets = (raw: string): string[] =>
    raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

  const planHotfix = () => {
    const tickets = parseTickets(hotfixTickets);
    if (tickets.length === 0) return;
    setHotfixPlan({ loading: true });
    setHotfixApply(null);
    vscode.postMessage({ type: MESSAGE_TYPES.PLAN_HOTFIX, tickets, baseVersions: hotfixBase });
  };

  const applyHotfix = (components?: string[]) => {
    const tickets = parseTickets(hotfixTickets);
    if (tickets.length === 0) return;
    setHotfixApply({ loading: true });
    vscode.postMessage({
      type: MESSAGE_TYPES.APPLY_HOTFIX,
      tickets,
      baseVersions: hotfixBase,
      branch: hotfixPlan?.plan?.branch,
      ...(components ? { components } : {}),
    });
  };

  const hotfixData = hotfixPlan?.plan;
  const hotfixMissingBase = (hotfixData?.components || []).filter((c) => !c.tag).map((c) => c.component);
  const canApplyHotfix =
    !!hotfixData && hotfixData.components.length > 0 && hotfixMissingBase.length === 0;
  const hotfixFailed = (hotfixApply?.results || [])
    .filter((r) => r.status === 'failed')
    .map((r) => r.component);

  const previewHasVercel = !!preview?.vars?.some((v) => v.target === 'vercel');
  const planData = plan?.plan;
  const checkedApplyKeys = (planData?.configVars || [])
    .filter((r) => (r.action === 'add' || r.action === 'update') && !uncheckedPlanKeys.has(r.key))
    .map((r) => r.key);
  const canApply = !!planData && planData.summary.conflict === 0 && checkedApplyKeys.length > 0;
  const failedKeys = (apply?.results || []).filter((r) => r.status === 'failed').map((r) => r.key);
  const toggleUncheckedPlanKey = (key: string) =>
    setUncheckedPlanKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const machEnvData = machEnvPlan?.plan;
  const checkedMachEnvKeys = (machEnvData?.configVars || [])
    .filter((r) => (r.action === 'add' || r.action === 'update') && !uncheckedMachEnvKeys.has(r.key))
    .map((r) => r.key);
  const canApplyMachEnv =
    !!machEnvData && machEnvData.summary.conflict === 0 && checkedMachEnvKeys.length > 0;
  const toggleUncheckedMachEnvKey = (key: string) =>
    setUncheckedMachEnvKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const machEnvFailedKeys = (machEnvApply?.results || [])
    .filter((r) => r.status === 'failed')
    .map((r) => r.key);

  // Per-pipeline step states drive the trackers in each PipelineCard header.
  const vStep1: StepState = plan?.error ? 'error' : plan?.plan ? 'done' : plan?.loading ? 'active' : 'pending';
  const vStep2: StepState = apply?.error ? 'error' : apply?.summary ? 'done' : apply?.loading ? 'active' : 'pending';
  const mcStep1: StepState = machPlan?.error
    ? 'error'
    : machPlan?.changes
      ? 'done'
      : machPlan?.loading
        ? 'active'
        : 'pending';
  // Trigger→PR is "active" from dispatch until the PR appears (polling), "done" once it opens.
  const mcStep2: StepState = machApply?.error ? 'error' : machApply?.pr ? 'done' : machApply ? 'active' : 'pending';
  const meStep1: StepState = machEnvPlan?.needsSync
    ? 'blocked'
    : machEnvPlan?.error
      ? 'error'
      : machEnvPlan?.plan
        ? 'done'
        : machEnvPlan?.loading
          ? 'active'
          : 'pending';
  const meStep2: StepState = machEnvApply?.error
    ? 'error'
    : machEnvApply?.summary
      ? 'done'
      : machEnvApply?.loading
        ? 'active'
        : 'pending';
  const hfStep1: StepState = hotfixPlan?.error
    ? 'error'
    : hotfixMissingBase.length > 0
      ? 'blocked'
      : hotfixPlan?.plan
        ? 'done'
        : hotfixPlan?.loading
          ? 'active'
          : 'pending';
  const hfStep2: StepState = hotfixApply?.error
    ? 'error'
    : hotfixApply?.summary
      ? 'done'
      : hotfixApply?.loading
        ? 'active'
        : 'pending';

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <div className="header-with-back">
          <button className="back-button" onClick={onBack} aria-label="Go back">
            ←
          </button>
          <h3>Releases</h3>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-header">
          <h3>Today's release</h3>
        </div>
        <div className="settings-form">
          {loading ? (
            <p style={{ color: '#a0a0a0' }}>Resolving…</p>
          ) : release?.configured ? (
            <div style={{ border: '1px solid #2a2a3e', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontSize: '0.8em', color: '#888' }}>{release.date}</div>
              <input
                type="text"
                value={overrideVersion}
                onChange={(e) => setOverrideVersion(e.target.value)}
                title="Resolved from the release roster — edit if it looks wrong"
                style={{
                  fontSize: '1.05em',
                  fontWeight: 500,
                  margin: '2px 0 6px',
                  width: '100%',
                  border: '1px solid var(--vscode-input-border, #3a3a52)',
                }}
              />
              {release.environment && (
                <span
                  style={{
                    fontSize: '0.75em',
                    background: '#1d3a5f',
                    color: '#85b7eb',
                    padding: '2px 8px',
                    borderRadius: 6,
                    textTransform: 'uppercase',
                  }}
                >
                  {release.environment}
                </span>
              )}
              {release.pilot && (
                <div style={{ fontSize: '0.85em', color: '#a0a0a0', marginTop: 8 }}>
                  Pilot: {release.pilot}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: '#a0a0a0', fontSize: '0.9em', lineHeight: 1.6 }}>
              <p style={{ margin: '0 0 6px' }}>
                {release?.needsVersion
                  ? `Release scheduled${release?.date ? ` for today (${release.date})` : ''}, but no version listed.`
                  : `No release resolved${release?.date ? ` for today (${release.date})` : ''}.`}
              </p>
              <p style={{ margin: 0, fontSize: '0.85em', color: '#888' }}>
                {release?.reason ||
                  'Configure the Release Roster page under Settings → Deployment Automation.'}
              </p>
              {release?.needsVersion && release?.pilot && (
                <p style={{ margin: '4px 0 0', fontSize: '0.85em', color: '#888' }}>Pilot: {release.pilot}</p>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <button
              onClick={() => setOverrideOpen((o) => !o)}
              style={{
                background: 'none',
                border: 'none',
                color: '#85b7eb',
                cursor: 'pointer',
                padding: 0,
                fontSize: '0.82em',
              }}
            >
              {overrideOpen ? '▾' : '▸'} {release?.needsVersion ? 'Enter version / release page URL' : 'Override version (testing)'}
            </button>
            {overrideOpen && (
              <div
                style={{
                  marginTop: 8,
                  padding: '10px 12px',
                  border: '1px dashed #3a3a52',
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'flex', gap: '16px 28px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                      {(['version', 'pageUrl'] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => {
                            setOverrideMode(mode);
                            if (mode === 'version') setOverridePageUrl('');
                            else setOverrideVersion('');
                          }}
                          style={{
                            fontSize: '0.78em',
                            padding: '3px 10px',
                            borderRadius: 6,
                            border: 'none',
                            cursor: 'pointer',
                            background: overrideMode === mode ? '#1d3a5f' : 'transparent',
                            color: overrideMode === mode ? '#85b7eb' : '#a0a0a0',
                          }}
                        >
                          {mode === 'version' ? 'Version' : 'Release page URL'}
                        </button>
                      ))}
                    </div>
                    {overrideMode === 'version' ? (
                      <input
                        type="text"
                        value={overrideVersion}
                        placeholder="e.g. web-2026-6.2"
                        onChange={(e) => setOverrideVersion(e.target.value)}
                        style={{ width: '100%' }}
                      />
                    ) : (
                      <input
                        type="text"
                        value={overridePageUrl}
                        placeholder="Confluence release page URL"
                        onChange={(e) => setOverridePageUrl(e.target.value)}
                        style={{ width: '100%' }}
                      />
                    )}
                  </div>
                  <div style={{ width: 130, flexShrink: 0 }}>
                    <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>Env</div>
                    <SearchableDropdown
                      value={overrideEnv}
                      options={[
                        { value: 'stage', label: 'stage' },
                        { value: 'prod', label: 'prod' },
                      ]}
                      onChange={(v) => {
                        setOverrideEnv(v);
                        setEnvTouched(true);
                      }}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={prepareConfigSync}
            disabled={!canPrepare || !!preview?.loading}
            title={canPrepare ? undefined : 'Resolve a release or set an override version first'}
            style={{ marginTop: 10, width: '100%' }}
          >
            {preview?.loading
              ? '⏳ Preparing…'
              : hasOverride
                ? `Prepare config sync (override: ${effectiveVersion || 'linked page'})`
                : 'Prepare config sync'}
          </button>

          {preview && !preview.loading && <ConfigPreview preview={preview} />}

          {preview && !preview.loading && !preview.error && previewHasVercel && (
            <PipelineCard
              accent={PIPE.vercel}
              index={1}
              title="Vercel"
              target="frontend env"
              steps={[
                { label: '① Plan', state: vStep1 },
                { label: '② Apply', state: vStep2 },
              ]}
            >
              <button
                onClick={planConfigSync}
                disabled={!!plan?.loading}
                style={{ ...pipeBtn(PIPE.vercel), marginTop: 0 }}
              >
                {plan?.loading
                  ? '⏳ Reading live Vercel…'
                  : plan?.plan
                    ? '✓ Re-plan against live Vercel'
                    : 'Plan against live Vercel →'}
              </button>

          {plan && !plan.loading && (
            <PlanReview state={plan} uncheckedKeys={uncheckedPlanKeys} onToggle={toggleUncheckedPlanKey} />
          )}

          {plan && !plan.loading && !plan.error && (
            <button
              onClick={() => applyConfigSync(checkedApplyKeys)}
              disabled={!canApply || !!apply?.loading}
              title={canApply ? undefined : 'Nothing to apply, or unresolved conflicts'}
              style={pipeBtn(PIPE.vercel)}
            >
              {apply?.loading
                ? '⏳ Applying…'
                : apply?.summary
                  ? '✓ Applied — re-apply'
                  : `Approve & apply (${effectiveEnv || 'stage'}) — ${checkedApplyKeys.length} change(s)`}
            </button>
          )}

          {apply && !apply.loading && (
            <div style={{ marginTop: 12 }}>
              {apply.error ? (
                <div className="status-message error" style={{ whiteSpace: 'pre-wrap' }}>
                  {apply.error}
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '0.85em', marginBottom: 6 }}>
                    <span style={{ color: '#4ecca3' }}>{apply.summary?.applied || 0} applied</span>
                    {!!apply.summary?.failed && (
                      <span style={{ color: '#e74c3c', marginLeft: 10 }}>
                        {apply.summary.failed} failed
                      </span>
                    )}
                  </div>
                  {(apply.results || []).map((r, i) => (
                    <div
                      key={`${r.key}-${i}`}
                      style={{ fontSize: '0.8em', padding: '4px 0', borderBottom: '1px solid #23233a' }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.key}</span>
                        <span
                          style={{
                            color: r.status === 'applied' ? '#4ecca3' : r.status === 'failed' ? '#e74c3c' : '#888',
                            flexShrink: 0,
                          }}
                        >
                          {r.status}
                        </span>
                      </div>
                      {r.error && (
                        <div
                          style={{
                            fontSize: '0.92em',
                            color: '#e0a0a0',
                            marginTop: 2,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {r.error}
                        </div>
                      )}
                      {r.reference && (
                        <div style={{ fontSize: '0.92em', color: '#e0a93b', marginTop: 2 }}>
                          ⚠️ {r.reference}
                        </div>
                      )}
                    </div>
                  ))}
                  {failedKeys.length > 0 && (
                    <button
                      onClick={() => applyConfigSync(failedKeys)}
                      style={{ marginTop: 10, width: '100%' }}
                    >
                      Retry failed ({failedKeys.length})
                    </button>
                  )}
                </>
              )}
            </div>
          )}
            </PipelineCard>
          )}

          {preview && !preview.loading && !preview.error && (
            <>
            <PipelineCard
              accent={PIPE.machComp}
              index={2}
              title="mach components"
              target="backend repo"
              steps={[
                { label: '① Plan', state: mcStep1 },
                { label: '② Trigger → PR', state: mcStep2 },
              ]}
            >
              <div style={{ fontSize: '0.8em', color: '#888', marginBottom: 10, lineHeight: 1.5 }}>
                Promote component versions from the source env into{' '}
                {effectiveEnv || 'stage'} via the sync workflow. Opens a PR for review — never
                auto-merged.
              </div>

              <button
                onClick={planMachSync}
                disabled={!!machPlan?.loading}
                style={{ ...pipeBtn(PIPE.machComp), marginTop: 0 }}
              >
                {machPlan?.loading
                  ? '⏳ Reading components.yml…'
                  : machPlan?.changes
                    ? '✓ Re-plan mach sync'
                    : 'Plan mach sync →'}
              </button>

              {machPlan && !machPlan.loading && <MachPlanReview state={machPlan} />}

              {machPlan && !machPlan.loading && !machPlan.error && (
                <button
                  onClick={applyMachSync}
                  disabled={!!machApply?.loading || (!!machApply && !machApply.error)}
                  style={pipeBtn(PIPE.machComp)}
                >
                  {machApply?.loading
                    ? '⏳ Dispatching workflow…'
                    : machApply && !machApply.error
                      ? 'Workflow dispatched'
                      : `Trigger mach sync (${machPlan.from} → ${machPlan.to})`}
                </button>
              )}

              {machApply && !machApply.loading && (
                <div style={{ marginTop: 12 }}>
                  {machApply.error ? (
                    <div className="status-message error" style={{ whiteSpace: 'pre-wrap' }}>
                      {machApply.error}
                    </div>
                  ) : (
                    <div style={{ fontSize: '0.82em', lineHeight: 1.7 }}>
                      {machApply.run ? (
                        <div>
                          Run{' '}
                          <a href={machApply.run.runUrl} style={{ color: '#85b7eb' }}>
                            #{machApply.run.runId}
                          </a>{' '}
                          ·{' '}
                          <span style={{ color: machApply.run.conclusion === 'success' ? '#4ecca3' : machApply.run.conclusion === 'failure' ? '#e74c3c' : '#e0a93b' }}>
                            {machApply.run.conclusion || machApply.run.status}
                          </span>
                          {!machRunCompleted && machPollActive && (
                            <span style={{ color: '#888' }}> · refreshing in {machCountdown}s</span>
                          )}
                        </div>
                      ) : (
                        <div style={{ color: '#888' }}>⏳ Locating the dispatched run…</div>
                      )}

                      {machApply.pr ? (
                        <div style={{ color: '#4ecca3' }}>
                          ✅ PR opened:{' '}
                          <a href={machApply.pr.url} style={{ color: '#85b7eb' }}>
                            #{machApply.pr.number}
                          </a>{' '}
                          {machApply.pr.merged ? '(merged)' : `(${machApply.pr.state})`} — review &amp; merge
                          {machApply.pr.title && (
                            <div style={{ color: '#a0a0a0', fontFamily: 'monospace', fontSize: '0.92em', marginTop: 1 }}>
                              {machApply.pr.title}
                            </div>
                          )}
                          {!machApply.pr.merged && machApply.postPr?.versionInjection && (
                            <div style={{ marginTop: 8 }}>
                              <button
                                onClick={injectWebappVersion}
                                disabled={!!machWebapp?.loading}
                                style={{ fontSize: '0.92em' }}
                                title={`Read the version Vercel deployed to the source env and commit it into this PR as "${machApply.postPr.versionInjection.component}"`}
                              >
                                {machWebapp?.loading ? '⏳ Reading Vercel…' : `Set ${machApply.postPr.versionInjection.component} version from Vercel`}
                              </button>
                              {machWebapp && !machWebapp.loading && (
                                <div style={{ marginTop: 4, fontSize: '0.92em' }}>
                                  {machWebapp.error ? (
                                    <span style={{ color: '#e74c3c' }}>{machWebapp.error}</span>
                                  ) : machWebapp.changed ? (
                                    <span style={{ color: '#4ecca3' }}>
                                      ✅ {machApply.postPr.versionInjection.component} → {machWebapp.newValue} (was {machWebapp.oldValue || '—'}) — committed to PR
                                    </span>
                                  ) : (
                                    <span style={{ color: '#888' }}>
                                      {machApply.postPr.versionInjection.component} already at {machWebapp.version} — no change
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#888', marginTop: 2 }}>
                          {machPollActive ? (
                            <span>
                              ⏳ Waiting for the PR (~5 min) — next check in{' '}
                              <strong style={{ color: '#a0a0a0' }}>{machCountdown}s</strong>
                            </span>
                          ) : machRunCompleted ? (
                            <span>Run finished without a PR (empty diff, or check the Actions tab).</span>
                          ) : (
                            <span>Waiting…</span>
                          )}
                          <button
                            onClick={recheckMach}
                            style={{ padding: '2px 8px', fontSize: '0.92em' }}
                            title="Check run & PR status now"
                          >
                            ↻ Recheck
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </PipelineCard>

            <PipelineCard
              accent={PIPE.machEnv}
              index={3}
              title="mach main.yml env vars"
              target="backend repo · env"
              dependsOn="needs the sync PR from ② — trigger mach sync first"
              steps={[
                { label: '① Plan', state: meStep1 },
                { label: '② Commit to PR', state: meStep2 },
              ]}
            >
              <div style={{ fontSize: '0.78em', color: '#888', marginBottom: 10, lineHeight: 1.5 }}>
                Diff the release's mach env vars against <code>main.yml</code> on the open sync PR,
                then commit any add/update to that same PR branch.
              </div>

              <button
                onClick={planMachEnv}
                disabled={!!machEnvPlan?.loading}
                style={{ ...pipeBtn(PIPE.machEnv), marginTop: 0 }}
              >
                {machEnvPlan?.loading
                  ? '⏳ Reading main.yml on the PR…'
                  : machEnvPlan?.plan
                    ? '✓ Re-plan main.yml env vars'
                    : 'Plan main.yml env vars →'}
              </button>

                {machEnvPlan?.needsSync && (
                  <div style={{ marginTop: 10, fontSize: '0.82em', color: '#e0a93b' }}>
                    No open sync PR yet — trigger mach sync above, wait for the PR to open, then plan
                    again.
                  </div>
                )}

                {machEnvPlan && !machEnvPlan.loading && !machEnvPlan.needsSync && (
                  <PlanReview
                    state={machEnvPlan}
                    uncheckedKeys={uncheckedMachEnvKeys}
                    onToggle={toggleUncheckedMachEnvKey}
                  />
                )}

                {machEnvPlan?.pr && !machEnvPlan.error && (
                  <div style={{ marginTop: 8, fontSize: '0.8em', color: '#a0a0a0' }}>
                    Diffing against PR{' '}
                    <a href={machEnvPlan.pr.url} style={{ color: '#85b7eb' }}>
                      #{machEnvPlan.pr.number}
                    </a>
                  </div>
                )}

                {machEnvData && !machEnvPlan?.loading && (
                  <button
                    onClick={() => applyMachEnv(checkedMachEnvKeys)}
                    disabled={!canApplyMachEnv || !!machEnvApply?.loading}
                    title={canApplyMachEnv ? undefined : 'Nothing to apply, or unresolved conflicts'}
                    style={pipeBtn(PIPE.machEnv)}
                  >
                    {machEnvApply?.loading
                      ? '⏳ Committing to PR…'
                      : `Commit env vars to PR — ${checkedMachEnvKeys.length} change(s)`}
                  </button>
                )}

                {machEnvApply && !machEnvApply.loading && (
                  <div style={{ marginTop: 12 }}>
                    {machEnvApply.error ? (
                      <div className="status-message error" style={{ whiteSpace: 'pre-wrap' }}>
                        {machEnvApply.error}
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: '0.85em', marginBottom: 6 }}>
                          <span style={{ color: '#4ecca3' }}>
                            {machEnvApply.summary?.applied || 0} committed
                          </span>
                          {!!machEnvApply.summary?.failed && (
                            <span style={{ color: '#e74c3c', marginLeft: 10 }}>
                              {machEnvApply.summary.failed} failed
                            </span>
                          )}
                        </div>
                        {(machEnvApply.results || []).map((r, i) => (
                          <div
                            key={`${r.key}-${i}`}
                            style={{ fontSize: '0.8em', padding: '4px 0', borderBottom: '1px solid #23233a' }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.key}</span>
                              <span
                                style={{
                                  color: r.status === 'applied' ? '#4ecca3' : r.status === 'failed' ? '#e74c3c' : '#888',
                                  flexShrink: 0,
                                }}
                              >
                                {r.status === 'applied' ? 'committed' : r.status}
                              </span>
                            </div>
                            {r.error && (
                              <div
                                style={{
                                  fontSize: '0.92em',
                                  color: '#e0a0a0',
                                  marginTop: 2,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {r.error}
                              </div>
                            )}
                          </div>
                        ))}
                        {machEnvFailedKeys.length > 0 && (
                          <button
                            onClick={() => applyMachEnv(machEnvFailedKeys)}
                            style={{ marginTop: 10, width: '100%' }}
                          >
                            Retry failed ({machEnvFailedKeys.length})
                          </button>
                        )}
                        <div style={{ fontSize: '0.78em', color: '#888', marginTop: 8 }}>
                          Committed to the PR branch — review &amp; merge the PR to deploy.
                        </div>
                      </>
                    )}
                  </div>
                )}
            </PipelineCard>
            </>
          )}
        </div>
      </div>

      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="section-header">
          <h3>Hotfix</h3>
        </div>
        <div className="settings-form">
          <p style={{ color: '#888', fontSize: '0.85em', margin: '0 0 10px', lineHeight: 1.5 }}>
            Cherry-pick commits by ticket onto a hotfix branch, then push a scoped tag + GitHub Release for
            each affected component (which fires its deploy). A separate flow from the config-sync release above.
          </p>
          <div
            style={{
              borderRadius: 10,
              border: `1px solid ${PIPE.hotfix}33`,
              borderLeft: `3px solid ${PIPE.hotfix}`,
              background: `${PIPE.hotfix}0d`,
              padding: '14px 16px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: PIPE.hotfix,
                  color: '#0b0b14',
                  fontSize: '0.72em',
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                ⛑
              </span>
              <span style={{ fontWeight: 600, color: PIPE.hotfix, fontSize: '0.92em' }}>
                Cherry-pick → tag → release
              </span>
              <span style={{ fontSize: '0.68em', color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                github
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '9px 0 12px', flexWrap: 'wrap' }}>
              {[
                { label: '① Plan', state: hfStep1 },
                { label: '② Apply', state: hfStep2 },
              ].map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span style={{ color: '#3a3a52', fontSize: '0.8em' }}>›</span>}
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: '0.75em',
                      color: STEP_LABEL_COLOR[s.state] || PIPE.hotfix,
                    }}
                  >
                    <StepDot state={s.state} accent={PIPE.hotfix} />
                    {s.label}
                  </span>
                </React.Fragment>
              ))}
            </div>

            <label style={{ fontSize: '0.8em', color: '#ccc', display: 'block', marginBottom: 4 }}>
              Hotfix tickets
            </label>
            <textarea
              value={hotfixTickets}
              onChange={(e) => setHotfixTickets(e.target.value)}
              placeholder="D2C-123456, D2C-123457"
              rows={2}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: '#0f0f1a',
                border: '1px solid #2a2a3e',
                borderRadius: 6,
                color: '#e0e0e0',
                fontSize: '0.85em',
                padding: '7px 9px',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />

            <button
              onClick={planHotfix}
              disabled={hotfixPlan?.loading || parseTickets(hotfixTickets).length === 0}
              className="primary-button"
              style={pipeBtn(PIPE.hotfix)}
            >
              {hotfixPlan?.loading ? 'Finding commits…' : hotfixData ? '✓ Re-plan' : 'Plan hotfix →'}
            </button>

            {hotfixPlan?.error && (
              <div style={{ color: '#e0a0a0', fontSize: '0.82em', marginTop: 10 }}>{hotfixPlan.error}</div>
            )}

            {hotfixData && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: '0.8em', color: '#a0a0a0', marginBottom: 8 }}>
                  Branch <span style={{ fontFamily: 'monospace', color: '#ccc' }}>{hotfixData.branch}</span> ·{' '}
                  {hotfixData.summary.commits} commit(s) · {hotfixData.summary.components} component(s)
                </div>

                {hotfixData.components.length === 0 && (
                  <div style={{ fontSize: '0.82em', color: '#e0a93b' }}>
                    No commits mapped to a component. Check the ticket ids and that commit titles carry a
                    Conventional-Commit scope (e.g. <code>fix(mms-bff): …</code>).
                  </div>
                )}

                {hotfixData.components.map((c) => (
                  <div
                    key={c.component}
                    style={{
                      border: '1px solid #23233a',
                      borderRadius: 8,
                      padding: '10px 12px',
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{c.component}</span>
                      {c.tag ? (
                        <span style={{ fontFamily: 'monospace', fontSize: '0.78em', color: '#4ecca3' }}>{c.tag}</span>
                      ) : (
                        <span style={{ fontSize: '0.75em', color: '#e0a93b' }}>base version needed</span>
                      )}
                    </div>

                    {!c.tag && (
                      <div style={{ marginTop: 6 }}>
                        <input
                          value={hotfixBase[c.component] ?? ''}
                          onChange={(e) =>
                            setHotfixBase((b) => ({ ...b, [c.component]: e.target.value }))
                          }
                          placeholder="base version, e.g. 1.2.3"
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            background: '#0f0f1a',
                            border: '1px solid #2a2a3e',
                            borderRadius: 6,
                            color: '#e0e0e0',
                            fontSize: '0.8em',
                            padding: '5px 8px',
                          }}
                        />
                      </div>
                    )}

                    <div style={{ marginTop: 8 }}>
                      {c.commits.map((cm) => (
                        <div
                          key={cm.sha}
                          style={{ fontSize: '0.78em', color: '#a0a0a0', padding: '3px 0', display: 'flex', gap: 6 }}
                        >
                          <span style={{ fontFamily: 'monospace', color: '#85b7eb', flexShrink: 0 }}>
                            {cm.sha.slice(0, 7)}
                          </span>
                          <span style={{ wordBreak: 'break-word' }}>{cm.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {hotfixData.unassigned.length > 0 && (
                  <div style={{ fontSize: '0.78em', color: '#e0a93b', marginBottom: 8 }}>
                    {hotfixData.unassigned.length} commit(s) had no derivable component and will be skipped.
                  </div>
                )}

                {hotfixMissingBase.length > 0 && (
                  <div style={{ fontSize: '0.78em', color: '#e0a93b', marginBottom: 8 }}>
                    Enter a base version for {hotfixMissingBase.join(', ')}, then Re-plan to compute tags.
                  </div>
                )}

                <button
                  onClick={() => applyHotfix()}
                  disabled={!canApplyHotfix || hotfixApply?.loading}
                  className="primary-button"
                  style={pipeBtn(PIPE.hotfix)}
                >
                  {hotfixApply?.loading
                    ? 'Cherry-picking + tagging…'
                    : `Approve & apply — ${hotfixData.components.length} component(s)`}
                </button>

                {hotfixApply?.error && (
                  <div style={{ color: '#e0a0a0', fontSize: '0.82em', marginTop: 10 }}>{hotfixApply.error}</div>
                )}

                {hotfixApply?.summary && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: '0.82em', color: '#a0a0a0', marginBottom: 6 }}>
                      {hotfixApply.summary.applied}/{hotfixApply.summary.total} released
                      {hotfixApply.summary.failed ? `, ${hotfixApply.summary.failed} failed` : ''} on{' '}
                      <span style={{ fontFamily: 'monospace', color: '#ccc' }}>{hotfixApply.branch}</span>
                    </div>
                    {(hotfixApply.results || []).map((r, i) => (
                      <div
                        key={`${r.component}-${i}`}
                        style={{ fontSize: '0.8em', padding: '4px 0', borderBottom: '1px solid #23233a' }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{r.tag}</span>
                          <span
                            style={{
                              color: r.status === 'applied' ? '#4ecca3' : '#e74c3c',
                              flexShrink: 0,
                            }}
                          >
                            {r.status === 'applied' ? 'released' : 'failed'}
                          </span>
                        </div>
                        {r.releaseUrl && (
                          <a
                            href={r.releaseUrl}
                            style={{ fontSize: '0.92em', color: '#85b7eb' }}
                          >
                            view release ↗
                          </a>
                        )}
                        {r.error && <div style={{ fontSize: '0.92em', color: '#e0a0a0' }}>{r.error}</div>}
                      </div>
                    ))}
                    {hotfixFailed.length > 0 && (
                      <button
                        onClick={() => applyHotfix(hotfixFailed)}
                        disabled={hotfixApply?.loading}
                        style={{
                          marginTop: 10,
                          background: 'none',
                          border: '1px solid #e74c3c',
                          color: '#e74c3c',
                          borderRadius: 6,
                          padding: '5px 10px',
                          fontSize: '0.8em',
                          cursor: 'pointer',
                        }}
                      >
                        Retry failed ({hotfixFailed.length})
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="settings-section" style={{ marginTop: 16 }}>
        <div className="section-header">
          <h3>Recent runs</h3>
        </div>
        <div className="settings-form">
          {runs.length === 0 ? (
            <p style={{ color: '#888', fontSize: '0.88em', margin: 0 }}>No runs yet.</p>
          ) : (
            runs.map((run, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '0.85em',
                  padding: '6px 0',
                  borderBottom: '1px solid #23233a',
                }}
              >
                <span>
                  {run.release} · {run.environment}
                </span>
                <span style={{ color: run.status === 'applied' ? '#4ecca3' : run.status === 'failed' ? '#e74c3c' : '#e0a93b' }}>
                  {run.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default Releases;
