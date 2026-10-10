import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';
import StatusDot from './StatusDot';

type Kind = 'github' | 'gitlab' | 'bitbucket';

interface Connection {
  id: string;
  kind: Kind;
  host: string;
  login: string;
  source: 'oauth' | 'token' | 'gh';
}

const LABEL: Record<Kind, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };
const DEFAULT_HOST: Record<Kind, string> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' };

const TOKEN_HELP: Record<'gitlab' | 'bitbucket', React.ReactNode> = {
  gitlab: (
    <>
      Create a personal access token with the <code>api</code> scope (<code>read_api</code> is enough if you only want to read, but opening merge requests needs <code>api</code>).
    </>
  ),
  bitbucket: (
    <>
      Bitbucket Cloud only. Use an API token with your account email as the username, or an app password with your username. It needs pull requests (read and write), pipelines (read) and account (read).
    </>
  ),
};

/**
 * Where the code and pull requests live: GitHub, GitLab or Bitbucket Cloud.
 * github.com can connect with the OAuth consent flow; everything else
 * connects with a token, because those OAuth apps are registered per
 * instance. The credential stays on the host side — this panel only ever sees
 * who is connected.
 */
const CodeHostSettings: React.FC = () => {
  const vscode = VSCodeAPI();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ error?: string; warning?: string }>({});
  const [kind, setKind] = useState<Kind>('github');
  const [host, setHost] = useState(DEFAULT_HOST.github);
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [detected, setDetected] = useState<string | null>(null);
  const [ghCode, setGhCode] = useState<{ code: string; url: string } | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === MESSAGE_TYPES.CODEHOST_GH_CODE) {
        setGhCode({ code: event.data.code, url: event.data.url });
        return;
      }
      if (event.data?.type !== MESSAGE_TYPES.CODEHOST_STATUS) return;
      setGhCode(null);
      setDetected(event.data.detected?.host ?? null);
      const list: Connection[] = event.data.connections ?? [];
      setConnections(list);
      setNotice({ error: event.data.error, warning: event.data.warning });
      setBusy(false);
      if (!event.data.error) {
        setToken('');
        setAdding(false);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: MESSAGE_TYPES.CODEHOST_GET_STATUS });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const pickKind = (next: Kind) => {
    setKind(next);
    setHost(DEFAULT_HOST[next]);
  };
  const connectToken = () => {
    setBusy(true);
    setNotice({});
    vscode.postMessage({ type: MESSAGE_TYPES.CODEHOST_CONNECT_TOKEN, kind, host, username, token });
  };
  const connectGh = () => {
    setBusy(true);
    setNotice({});
    setGhCode(null);
    vscode.postMessage({ type: MESSAGE_TYPES.CODEHOST_CONNECT_GH, host: 'github.com' });
  };
  const cancelSignIn = () => {
    vscode.postMessage({ type: MESSAGE_TYPES.CODEHOST_CANCEL_OAUTH });
    setBusy(false);
    setGhCode(null);
  };
  const connectOAuth = () => {
    setBusy(true);
    setNotice({});
    vscode.postMessage({ type: MESSAGE_TYPES.CODEHOST_CONNECT_OAUTH });
  };

  const showForm = adding || (connections.length === 0 && !detected);
  const summary = !connections.length && detected ? (
    <>
      <StatusDot tone='ok' />
      GitHub CLI · {detected}
    </>
  ) : connections.length ? (
    <>
      <StatusDot tone={notice.warning ? 'warn' : 'ok'} />
      {connections.map((c) => `${c.login}@${c.host}`).join(', ')}
    </>
  ) : (
    'Not connected'
  );

  return (
    <SectionShell storageKey='codehost' title='Code hosts' summary={summary} needsAttention={!!notice.error || !!notice.warning}>
      <div className='settings-form'>
        {connections.map((c) => (
          <div className='connected-banner' key={c.id}>
            <span className='connected-label'>
              <StatusDot tone='ok' />
              Connected to <strong>{LABEL[c.kind]}</strong> ({c.host}) as {c.login}
            </span>
            <button type='button' className='disconnect-link' onClick={() => vscode.postMessage({ type: MESSAGE_TYPES.CODEHOST_DISCONNECT, id: c.id })}>
              Disconnect
            </button>
          </div>
        ))}

        {detected && (
          <div className='connected-banner'>
            <span className='connected-label'>
              <StatusDot tone='ok' />
              Using your GitHub CLI sign-in for <strong>{detected}</strong>
            </span>
          </div>
        )}

        {showForm ? (
          <div className='oauth-connect connection-setup'>
            <p className='description-text'>
              Connect where your code lives so WorkspaceGPT can show your pull requests and CI, open pull requests against your default branch, and read them for the agent.
            </p>
            <div className='form-group'>
              <label>Provider</label>
              <select className='settings-select' value={kind} onChange={(e) => pickKind(e.target.value as Kind)}>
                <option value='github'>GitHub</option>
                <option value='gitlab'>GitLab (gitlab.com or self-managed)</option>
                <option value='bitbucket'>Bitbucket Cloud</option>
              </select>
            </div>
            {kind === 'gitlab' && (
              <div className='form-group'>
                <label>Host</label>
                <input type='text' value={host} onChange={(e) => setHost(e.target.value)} placeholder={`${DEFAULT_HOST[kind]} or git.yourcompany.com`} />
              </div>
            )}
            {kind === 'github' && (
              <>
                <button onClick={connectGh} disabled={busy} className='primary-button-full connection-button'>
                  {busy ? 'Waiting for authorization…' : 'Sign in with GitHub CLI'}
                </button>
                {ghCode && (
                  <p className='description-text' role='status'>
                    Your browser opened to authorize. If GitHub asks for a code, enter <strong>{ghCode.code}</strong> at {ghCode.url}. If your organization uses SSO, authorize access for it when GitHub asks.
                  </p>
                )}
                {busy && (
                  <button onClick={cancelSignIn} className='secondary-button connection-button'>
                    Cancel
                  </button>
                )}
                <p className='description-text'>Needs the GitHub CLI (<code>gh</code>) installed, and works with organizations that restrict third-party apps. No token to create.</p>
              </>
            )}
            {kind === 'github' && (
              <>
                <button onClick={connectOAuth} disabled={busy} className='secondary-button connection-button'>
                  {busy ? 'Connecting…' : 'Connect with GitHub (OAuth)'}
                </button>
                <p className='description-text'>Organizations that restrict third-party apps (managed accounts) may block this one; use the GitHub CLI above.</p>
              </>
            )}
            {kind === 'bitbucket' && (
              <div className='form-group'>
                <label>Username or account email</label>
                <input type='text' value={username} onChange={(e) => setUsername(e.target.value)} autoComplete='off' />
              </div>
            )}
            {kind !== 'github' && (
              <>
                <div className='form-group'>
                  <label>{kind === 'bitbucket' ? 'API token or app password' : 'Personal access token'}</label>
                  <input type='password' value={token} onChange={(e) => setToken(e.target.value)} placeholder='Paste a token' autoComplete='off' />
                  <p className='description-text'>{TOKEN_HELP[kind]} It is kept in your system keychain.</p>
                </div>
                <button
                  onClick={connectToken}
                  disabled={busy || !token.trim() || (kind === 'gitlab' && !host.trim()) || (kind === 'bitbucket' && !username.trim())}
                  className='primary-button-full connection-button'
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
              </>
            )}
            {connections.length > 0 && (
              <button type='button' className='link-like' onClick={() => setAdding(false)}>
                Cancel
              </button>
            )}
          </div>
        ) : (
          <button type='button' className='secondary-button connection-button' onClick={() => setAdding(true)}>
            Add another host
          </button>
        )}

        {notice.warning && <p className='description-text'>{notice.warning}</p>}
        {notice.error && <p className='description-text' role='alert'>{notice.error}</p>}
      </div>
    </SectionShell>
  );
};

export default CodeHostSettings;
