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
}

const RemoteAccountSettings: React.FC = () => {
  const vscode = VSCodeAPI();
  const [status, setStatus] = useState<RemoteSessionStatus>({ signedIn: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    vscode.postMessage({ type: MESSAGE_TYPES.CHECK_REMOTE_SESSION });

    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      switch (message.type) {
        case MESSAGE_TYPES.REMOTE_SESSION_STATUS:
          setStatus({ signedIn: !!message.signedIn, githubLogin: message.githubLogin });
          setLoading(false);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_IN_SUCCESS:
          setStatus({ signedIn: true, githubLogin: message.githubLogin });
          setLoading(false);
          setError(null);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_IN_ERROR:
          setError(message.message || 'Sign-in failed');
          setLoading(false);
          break;
        case MESSAGE_TYPES.REMOTE_SIGN_OUT_SUCCESS:
          setStatus({ signedIn: false });
          setLoading(false);
          break;
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const signIn = () => {
    setLoading(true);
    setError(null);
    vscode.postMessage({ type: MESSAGE_TYPES.START_REMOTE_SIGN_IN });
  };

  const signOut = () => {
    setLoading(true);
    vscode.postMessage({ type: MESSAGE_TYPES.SIGN_OUT_REMOTE });
  };

  const summary = status.signedIn
    ? `✅ Signed in${status.githubLogin ? ` as ${status.githubLogin}` : ''}`
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
            <button type='button' className='secondary-button' onClick={signOut} disabled={loading}>
              {loading ? '⏳ Signing out…' : 'Sign out'}
            </button>
          </div>
        ) : (
          <div className='form-group'>
            <button
              type='button'
              className='primary-button-full'
              onClick={signIn}
              disabled={loading}
            >
              {loading ? '⏳ Signing in…' : '🔗 Sign Up with WorkspaceGPT'}
            </button>
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
