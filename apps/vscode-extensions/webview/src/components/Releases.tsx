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
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (isVisible) {
      setLoading(true);
      setPreview(null);
      vscode.postMessage({ type: MESSAGE_TYPES.RESOLVE_RELEASE });
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
    }
  }, [isVisible]);

  if (!isVisible) return null;

  const canPrepare = !!release?.configured;

  const prepareConfigSync = () => {
    if (!release?.configured) return;
    setPreview({ loading: true });
    vscode.postMessage({
      type: MESSAGE_TYPES.PREPARE_CONFIG_SYNC,
      version: release.version,
      environment: release.environment,
    });
  };

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

          <button
            onClick={prepareConfigSync}
            disabled={!canPrepare || !!preview?.loading}
            title={canPrepare ? undefined : 'Available once a release source is configured'}
            style={{ marginTop: 12, width: '100%' }}
          >
            {preview?.loading ? '⏳ Preparing…' : 'Prepare config sync'}
          </button>

          {preview && !preview.loading && <ConfigPreview preview={preview} />}
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
