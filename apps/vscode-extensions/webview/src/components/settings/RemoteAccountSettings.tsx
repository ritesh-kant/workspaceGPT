import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';

/**
 * RECONSTRUCTED 2026-08-31 — deleted by mistake earlier in the same session
 * (before it had ever been committed) and rebuilt from context: the
 * WebviewMessageHandler sign-in gate's comment ("The Settings panel's 'Sign
 * Up with WorkspaceGPT' button (RemoteAccountSettings.tsx) is the normal
 * path in"), the CHECK_REMOTE_SESSION/START_REMOTE_SIGN_IN/SIGN_OUT_REMOTE
 * message contract in constants.ts, and the SectionShell convention every
 * other current settings card (ModeSelector, ShareSettings,
 * ConfluenceSettings) already uses. The exact original markup/copy is not
 * recoverable — this is a functional rebuild, not a byte-identical restore.
 */
interface RemoteSessionStatus {
  signedIn: boolean;
  githubLogin?: string;
  plan?: string;
  requestsUsedThisWeek?: number;
  requestsLimitWeekly?: number;
}

/** Next Monday 00:00 UTC — same reset the Worker uses in usage.ts. */
function nextWeeklyReset(now = new Date()): Date {
  const isoDayNumber = now.getUTCDay() || 7; // Mon=1 … Sun=7
  const daysUntilMonday = 8 - isoDayNumber;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
}

function formatRefreshIn(now = new Date()): string {
  const ms = Math.max(0, nextWeeklyReset(now).getTime() - now.getTime());
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

function usageTone(remainingPct: number): 'ok' | 'warn' | 'critical' {
  if (remainingPct <= 10) return 'critical';
  if (remainingPct <= 25) return 'warn';
  return 'ok';
}

const RING_SIZE = 72;
const RING_STROKE = 5.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const WeeklyUsageCard: React.FC<{ used: number; limit: number }> = ({ used, limit }) => {
  const remaining = Math.max(0, limit - used);
  const remainingPct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  const clampedPct = Math.min(100, Math.max(0, remainingPct));
  const tone = usageTone(clampedPct);
  const exhausted = remaining === 0;
  const refreshIn = formatRefreshIn();
  const dashOffset = RING_CIRCUMFERENCE * (1 - clampedPct / 100);

  const title = exhausted ? 'Weekly limit reached' : 'Weekly remaining';
  const detail = `${remaining} / ${limit} left · refreshes in ${refreshIn}`;

  return (
    <div
      className={`usage-meter usage-meter--${tone}`}
      role='status'
      aria-label={`${title}: ${clampedPct}% remaining. ${detail}`}
    >
      <div className='usage-ring-wrap' aria-hidden='true'>
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
          <circle
            className='usage-ring-track'
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill='none'
            strokeWidth={RING_STROKE}
          />
          <circle
            className='usage-ring-value'
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill='none'
            strokeWidth={RING_STROKE}
            strokeLinecap='round'
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
        <span className='usage-ring-pct'>{clampedPct}%</span>
      </div>
      <div className='usage-meter-title'>{title}</div>
      <div className='usage-meter-detail'>{detail}</div>
    </div>
  );
};

const RemoteAccountSettings: React.FC = () => {
  const vscode = VSCodeAPI();
  const [status, setStatus] = useState<RemoteSessionStatus>({ signedIn: false });
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CHECK_REMOTE_SESSION });

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case MESSAGE_TYPES.REMOTE_SESSION_STATUS:
          setStatus({
            signedIn: !!message.signedIn,
            githubLogin: message.githubLogin,
            plan: message.plan,
            requestsUsedThisWeek: message.requestsUsedThisWeek,
            requestsLimitWeekly: message.requestsLimitWeekly,
          });
          setBusy(false);
          setChecking(false);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS:
          setStatus({
            signedIn: true,
            githubLogin: message.githubLogin,
            plan: message.plan,
            requestsUsedThisWeek: message.requestsUsedThisWeek,
            requestsLimitWeekly: message.requestsLimitWeekly,
          });
          setBusy(false);
          setChecking(false);
          setError(null);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_IN_ERROR:
          setError(message.message || 'Sign-in failed');
          setBusy(false);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS:
          setStatus({ signedIn: false });
          setBusy(false);
          setChecking(false);
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const signIn = () => {
    setBusy(true);
    setError(null);
    vscode.postMessage({ type: MESSAGE_TYPES.START_REMOTE_SIGN_IN });
  };

  const signOut = () => {
    setBusy(true);
    vscode.postMessage({ type: MESSAGE_TYPES.SIGN_OUT_REMOTE });
  };

  const remainingPct =
    typeof status.requestsLimitWeekly === 'number' && status.requestsLimitWeekly > 0
      ? Math.max(
          0,
          Math.round(
            ((status.requestsLimitWeekly - (status.requestsUsedThisWeek ?? 0)) / status.requestsLimitWeekly) * 100
          )
        )
      : null;

  const summary = checking
    ? 'Checking session…'
    : status.signedIn
      ? `✅ Signed in${status.githubLogin ? ` as ${status.githubLogin}` : ''}${
          remainingPct === null ? '' : ` · ${remainingPct}% left this week`
        }`
      : 'Not signed in';

  return (
    <SectionShell
      storageKey='remote-account'
      title='Account'
      summary={summary}
      needsAttention={!status.signedIn}
    >
      <div className='settings-form'>
        {status.signedIn ? (
          <div className='form-group'>
            {typeof status.requestsLimitWeekly === 'number' && (
              <WeeklyUsageCard
                used={status.requestsUsedThisWeek ?? 0}
                limit={status.requestsLimitWeekly}
              />
            )}
            <div className='account-footer'>
              <span className='account-identity'>
                Signed in as {status.githubLogin || 'GitHub'}
                {status.plan ? ` · ${status.plan}` : ''}
              </span>
              <button
                type='button'
                className='account-signout'
                onClick={signOut}
                disabled={busy || checking}
              >
                {busy ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        ) : (
          <div className='form-group'>
            <button
              type='button'
              className='primary-button-full'
              onClick={signIn}
              disabled={busy || checking}
            >
              {busy ? '⏳ Signing in…' : '🔗 Sign Up with WorkspaceGPT'}
            </button>
            <small className='form-text'>
              Remote mode needs an account: every answer is generated by WorkspaceGPT's
              managed model, and each request is checked against your session.
            </small>
            {error && (
              <div className='status-message error' style={{ marginTop: '8px' }}>
                ❌ {error}
              </div>
            )}
          </div>
        )}
      </div>
    </SectionShell>
  );
};

export default RemoteAccountSettings;
