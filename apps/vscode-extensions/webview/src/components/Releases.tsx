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
              <span style={{ color: '#a0a0a0', fontFamily: 'monospace', wordBreak: 'break-all', textAlign: 'right' }}>
                {v.sensitive ? '••••••' : v.value}
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
const PlanReview: React.FC<{ state: PlanState }> = ({ state }) => {
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

      {configVars.map((r, i) => (
        <div
          key={`${r.key}-${i}`}
          style={{
            padding: '6px 0',
            borderBottom: '1px solid #23233a',
            opacity: r.action === 'match' ? 0.55 : 1,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: '0.82em', wordBreak: 'break-all' }}>
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
                : `${r.opaque ? '(value hidden)' : r.current === null ? '(none)' : r.current} → ${r.desired}`}
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
      ))}

      {state.skipped && state.skipped.length > 0 && (
        <div style={{ marginTop: 12, fontSize: '0.8em', color: '#888' }}>
          {state.skipped.length} variable{state.skipped.length === 1 ? '' : 's'} skipped (no target
          configured yet): {state.skipped.map((s) => s.key).join(', ')}
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
          main.yml env-var sync is enabled — its changes aren't previewed here yet.
        </div>
      )}
    </div>
  );
};

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
  const [apply, setApply] = useState<ApplyState | null>(null);
  const [machPlan, setMachPlan] = useState<MachPlanState | null>(null);
  const [machApply, setMachApply] = useState<MachApplyState | null>(null);
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
  const [overrideVersion, setOverrideVersion] = useState('');
  const [overrideEnv, setOverrideEnv] = useState('stage');

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
          });
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

  // The override (when set) wins over the resolved release — used for testing
  // config-sync against an arbitrary version/env.
  const hasOverride = overrideVersion.trim().length > 0;
  const effectiveVersion = hasOverride ? overrideVersion.trim() : release?.version;
  const effectiveEnv = hasOverride ? overrideEnv : release?.environment;
  const canPrepare = !!release?.configured || hasOverride;

  const prepareConfigSync = () => {
    if (!effectiveVersion) return;
    setPreview({ loading: true });
    setPlan(null);
    setApply(null);
    vscode.postMessage({
      type: MESSAGE_TYPES.PREPARE_CONFIG_SYNC,
      version: effectiveVersion,
      environment: effectiveEnv || 'stage',
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

  const previewHasVercel = !!preview?.vars?.some((v) => v.target === 'vercel');
  const planData = plan?.plan;
  const canApply =
    !!planData &&
    planData.summary.conflict === 0 &&
    planData.summary.add + planData.summary.update > 0;
  const failedKeys = (apply?.results || []).filter((r) => r.status === 'failed').map((r) => r.key);

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
              <div style={{ fontSize: '1.05em', fontWeight: 500, margin: '2px 0 6px' }}>
                {release.version}
              </div>
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
                No release resolved{release?.date ? ` for today (${release.date})` : ''}.
              </p>
              <p style={{ margin: 0, fontSize: '0.85em', color: '#888' }}>
                {release?.reason ||
                  'Configure the Release Roster page under Settings → Deployment Automation.'}
              </p>
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
              {overrideOpen ? '▾' : '▸'} Override version (testing)
            </button>
            {overrideOpen && (
              <div
                style={{
                  marginTop: 8,
                  padding: '10px 12px',
                  border: '1px dashed #3a3a52',
                  borderRadius: 8,
                  display: 'flex',
                  gap: '28px',
                  alignItems: 'flex-end',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>Version</div>
                  <input
                    type="text"
                    value={overrideVersion}
                    placeholder="e.g. web-2026-6.2"
                    onChange={(e) => setOverrideVersion(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ width: 130, flexShrink: 0 }}>
                  <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>Env</div>
                  <SearchableDropdown
                    value={overrideEnv}
                    options={[
                      { value: 'stage', label: 'stage' },
                      { value: 'prod', label: 'prod' },
                    ]}
                    onChange={setOverrideEnv}
                  />
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
                ? `Prepare config sync (override: ${effectiveVersion})`
                : 'Prepare config sync'}
          </button>

          {preview && !preview.loading && <ConfigPreview preview={preview} />}

          {preview && !preview.loading && !preview.error && previewHasVercel && (
            <button
              onClick={planConfigSync}
              disabled={!!plan?.loading}
              style={{ marginTop: 12, width: '100%' }}
            >
              {plan?.loading ? '⏳ Reading live Vercel…' : 'Plan against live Vercel →'}
            </button>
          )}

          {plan && !plan.loading && <PlanReview state={plan} />}

          {plan && !plan.loading && !plan.error && (
            <button
              onClick={() => applyConfigSync()}
              disabled={!canApply || !!apply?.loading}
              title={canApply ? undefined : 'Nothing to apply, or unresolved conflicts'}
              style={{ marginTop: 12, width: '100%' }}
            >
              {apply?.loading
                ? '⏳ Applying…'
                : `Approve & apply (${effectiveEnv || 'stage'}) — ${
                    (planData?.summary.add || 0) + (planData?.summary.update || 0)
                  } change(s)`}
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

          {canPrepare && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #23233a' }}>
              <div style={{ fontSize: '0.85em', fontWeight: 600, color: '#85b7eb', marginBottom: 4 }}>
                mach backend sync
              </div>
              <div style={{ fontSize: '0.8em', color: '#888', marginBottom: 8, lineHeight: 1.5 }}>
                Promote component versions from the source env into{' '}
                {effectiveEnv || 'stage'} via the sync workflow. Opens a PR for review — never
                auto-merged.
              </div>

              <button onClick={planMachSync} disabled={!!machPlan?.loading} style={{ width: '100%' }}>
                {machPlan?.loading ? '⏳ Reading components.yml…' : 'Plan mach sync →'}
              </button>

              {machPlan && !machPlan.loading && <MachPlanReview state={machPlan} />}

              {machPlan && !machPlan.loading && !machPlan.error && (
                <button
                  onClick={applyMachSync}
                  disabled={!!machApply?.loading || (!!machApply && !machApply.error)}
                  style={{ marginTop: 12, width: '100%' }}
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
            </div>
          )}
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
