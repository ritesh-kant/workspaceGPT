import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';

interface BrowserStatus {
  enabled: boolean;
  connected: boolean;
}

/**
 * Desktop only: the Control Chrome connector. The agent drives the user's own
 * Chrome through the WorkspaceGPT Chrome extension, so Install opens the
 * extension's Web Store page in Chrome (one click on "Add to Chrome" there —
 * Chrome lets no program install an extension silently), and the card flips to
 * Connected on its own once the extension reaches this app.
 */
const ChromeSettings: React.FC = () => {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [opened, setOpened] = useState<null | { inChrome: boolean }>(null);

  useEffect(() => {
    const vscode = VSCodeAPI();
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === MESSAGE_TYPES.BROWSER_STATUS) setStatus({ enabled: !!data.enabled, connected: !!data.connected });
      else if (data?.type === MESSAGE_TYPES.BROWSER_INSTALL_OPENED) setOpened({ inChrome: !!data.inChrome });
    };
    window.addEventListener('message', onMessage);
    const ask = () => vscode.postMessage({ type: MESSAGE_TYPES.GET_BROWSER_STATUS });
    ask();
    const timer = setInterval(ask, 2000);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(timer);
    };
  }, []);

  const setEnabled = (enabled: boolean) => {
    setStatus((s) => ({ connected: s?.connected ?? false, enabled }));
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.SET_BROWSER_ENABLED, enabled });
  };

  const connected = !!status?.connected;
  const summary = !status ? '' : connected ? '✅ Connected to Chrome' : 'Chrome extension not connected';

  return (
    <SectionShell storageKey='connector-chrome' title='Control Chrome' summary={summary} defaultOpen>
      <div className='settings-form'>
        <small className='form-text'>
          Lets WorkspaceGPT open pages, read them, click and type in your own Chrome, signed in as you, to check a change or debug a web app. It works
          only in its own “WorkspaceGPT” tab group or the tab you are looking at, and asks you before anything hard to undo.
        </small>
        <div className='form-group'>
          <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span>Allow WorkspaceGPT to control Chrome</span>
            <button
              type='button'
              role='switch'
              aria-checked={!!status?.enabled}
              aria-label='Allow WorkspaceGPT to control Chrome'
              className={`plus-switch${status?.enabled ? ' plus-switch--on' : ''}`}
              onClick={() => setEnabled(!status?.enabled)}
            >
              <span className='plus-switch-knob' />
            </button>
          </label>
        </div>
        {!connected && (
          <div className='form-group'>
            <button type='button' className='primary-button-full connection-button' onClick={() => VSCodeAPI().postMessage({ type: MESSAGE_TYPES.INSTALL_CHROME_EXTENSION })}>
              Install Chrome extension
            </button>
            <small className='form-text'>
              {opened
                ? opened.inChrome
                  ? 'Opened in Chrome — click “Add to Chrome” there. This turns to Connected on its own once the extension starts.'
                  : 'Chrome could not be started, so the page opened in your default browser. Open it in Chrome and click “Add to Chrome”.'
                : 'Opens the extension’s page in Chrome. Click “Add to Chrome” there to finish.'}
            </small>
          </div>
        )}
      </div>
    </SectionShell>
  );
};

export default ChromeSettings;
