import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';
import StatusDot from './StatusDot';

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
  email?: string;
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

/**
 * Weekly quota as one line plus a thin bar. The previous 72px ring with the
 * percentage inside took a third of the Settings viewport for a number the
 * user glances at occasionally; the fraction and the reset date say the same
 * thing in a single row.
 */
const WeeklyUsageRow: React.FC<{ used: number; limit: number }> = ({ used, limit }) => {
  const remaining = Math.max(0, limit - used);
  const remainingPct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  const clampedPct = Math.min(100, Math.max(0, remainingPct));
  const tone = usageTone(clampedPct);
  const exhausted = remaining === 0;
  const refreshIn = formatRefreshIn();

  const detail = exhausted
    ? `Weekly limit reached · 0 remaining of ${limit} · resets in ${refreshIn}`
    : `${remaining} remaining · ${used} used of ${limit} · resets in ${refreshIn}`;

  return (
    <div className={`usage-row usage-row--${tone}`} role='status' aria-label={detail}>
      <div className='usage-row-bar' aria-hidden='true'>
        <div className='usage-row-fill' style={{ width: `${clampedPct}%` }} />
      </div>
      <div className='usage-row-detail'>{detail}</div>
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
            email: message.email,
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
            email: message.email,
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

  const remaining =
    typeof status.requestsLimitWeekly === 'number' && status.requestsLimitWeekly > 0
      ? Math.max(0, status.requestsLimitWeekly - (status.requestsUsedThisWeek ?? 0))
      : null;

  const summary = checking ? (
    'Checking session…'
  ) : status.signedIn ? (
    <>
      <StatusDot tone='ok' />
      {status.githubLogin || 'Signed in'}
      {remaining === null ? '' : ` · ${remaining} left this week`}
    </>
  ) : (
    'Not signed in'
  );

  const planLabel = status.plan
    ? status.plan.charAt(0).toUpperCase() + status.plan.slice(1)
    : undefined;

  return (
    <SectionShell
      storageKey='remote-account'
      title='Account'
      summary={summary}
      needsAttention={!status.signedIn}
    >
      <div className='settings-form'>
        {status.signedIn ? (
          <div className='account-card'>
            <div className='account-row'>
              <span className='account-avatar' aria-hidden='true'>
                {(status.githubLogin || '?').charAt(0).toUpperCase()}
              </span>
              <span className='account-identity'>
                <span className='account-name'>{status.githubLogin || 'GitHub account'}</span>
                {status.email && <span className='account-email'>{status.email}</span>}
                {planLabel && <span className='account-plan'>{planLabel} plan</span>}
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
            {typeof status.requestsLimitWeekly === 'number' && (
              <WeeklyUsageRow
                used={status.requestsUsedThisWeek ?? 0}
                limit={status.requestsLimitWeekly}
              />
            )}
          </div>
        ) : (
          <div className='form-group'>
            <button
              type='button'
              className='primary-button-full'
              onClick={signIn}
              disabled={busy || checking}
            >
              {busy ? 'Signing in…' : 'Sign in to WorkspaceGPT'}
            </button>
            <small className='form-text'>
              Remote mode needs an account: answers come from WorkspaceGPT’s managed
              model, and each request is checked against your session.
            </small>
            {error && (
              <div className='status-message error' style={{ marginTop: '8px' }}>
                {error}
              </div>
            )}
          </div>
        )}
      </div>
    </SectionShell>
  );
};

export default RemoteAccountSettings;
