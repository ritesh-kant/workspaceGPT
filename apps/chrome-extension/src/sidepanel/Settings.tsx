import React, { useEffect, useState } from 'react';
import { BRIDGE_STATUS_KEY, BridgeStatus } from '../lib/bridgeShared';

/** The desktop agent's access to this browser is always on; this only says how answers are produced. */
const BrowserAccess: React.FC = () => {
  const [status, setStatus] = useState<BridgeStatus | null>(null);

  useEffect(() => {
    chrome.storage.local.get(BRIDGE_STATUS_KEY).then((s) => setStatus(s[BRIDGE_STATUS_KEY] ?? null));
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'local' && BRIDGE_STATUS_KEY in changes) setStatus(changes[BRIDGE_STATUS_KEY].newValue ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  return (
    <>
      <div className='field-group-title' style={{ marginTop: 20 }}>WorkspaceGPT Desktop</div>
      {status && (
        <p className='settings-hint'>
          Answers come from WorkspaceGPT Desktop, using the model you picked there. Keep the app running.
        </p>
      )}
    </>
  );
};

interface Props {
  onClose: () => void;
}

const Settings: React.FC<Props> = () => (
  <div className='settings'>
    <div className='field-group-title'>Connection</div>
    <p className='settings-hint'>
      This panel has no model or keys of its own. It asks WorkspaceGPT Desktop, which uses the model you picked there
      and your own Knowledge. Keep the desktop app running. New here? Get started at{' '}
      <a href='https://www.workspacegpt.in' target='_blank' rel='noopener noreferrer'>
        workspacegpt.in
      </a>
      .
    </p>
    <BrowserAccess />
  </div>
);

export default Settings;
