import React, { useEffect, useState } from 'react';
import './Settings.css';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';

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
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (isVisible) {
      setLoading(true);
      setPreview(null);
      setPlan(null);
      setApply(null);
      vscode.postMessage({ type: MESSAGE_TYPES.RESOLVE_RELEASE });
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
    }
  }, [isVisible]);

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
                  gap: 8,
                  alignItems: 'flex-end',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>Version</div>
                  <input
                    type="text"
                    value={overrideVersion}
                    placeholder="e.g. mms-2026-6.2"
                    onChange={(e) => setOverrideVersion(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ width: 110 }}>
                  <div style={{ fontSize: '0.78em', color: '#a0a0a0', marginBottom: 2 }}>Env</div>
                  <select
                    value={overrideEnv}
                    onChange={(e) => setOverrideEnv(e.target.value)}
                    style={{ width: '100%' }}
                  >
                    <option value="stage">stage</option>
                    <option value="prod">prod</option>
                  </select>
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
