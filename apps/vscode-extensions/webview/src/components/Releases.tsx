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
}

interface ReleaseRun {
  release: string;
  environment: string;
  status: 'applied' | 'awaiting' | 'failed' | 'planned';
  at?: string;
}

interface ReleasesProps {
  isVisible: boolean;
  onBack: () => void;
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
          });
          setLoading(false);
          break;
        case MESSAGE_TYPES.GET_RELEASE_RUNS_RESPONSE:
          setRuns(message.runs || []);
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (isVisible) {
      setLoading(true);
      vscode.postMessage({ type: MESSAGE_TYPES.RESOLVE_RELEASE });
      vscode.postMessage({ type: MESSAGE_TYPES.GET_RELEASE_RUNS });
    }
  }, [isVisible]);

  if (!isVisible) return null;

  const canPrepare = !!release?.configured;

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
                No release source connected yet{release?.date ? ` (today: ${release.date})` : ''}.
              </p>
              <p style={{ margin: 0, fontSize: '0.85em', color: '#888' }}>
                Resolving today's release from Confluence is coming in the next
                milestone. Connect providers under Settings → Deployment Automation
                in the meantime.
              </p>
            </div>
          )}

          <button
            disabled={!canPrepare}
            title={canPrepare ? undefined : 'Available once a release source is configured'}
            style={{ marginTop: 12, width: '100%' }}
          >
            Prepare config sync
          </button>
        </div>
      </div>

      <div className="settings-section">
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
