import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import type { SyncSection } from './SyncControls';

interface Info {
  items: number;
  bytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * What a Knowledge source has stored on this machine, with a way to open the
 * folder and to delete it. Everything here is read from local files; nothing is
 * fetched or sent anywhere.
 */
const LocalDataLine: React.FC<{ section: SyncSection; busy: boolean; refreshKey?: string }> = ({
  section,
  busy,
  refreshKey,
}) => {
  const [info, setInfo] = useState<Info | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.SOURCE_DATA_INFO && m.section === section) {
        setInfo({ items: m.items, bytes: m.bytes });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [section]);

  // Re-read after a sync or index run finishes, not on every progress tick.
  useEffect(() => {
    if (!busy) VSCodeAPI().postMessage({ type: MESSAGE_TYPES.SOURCE_DATA_GET, section });
  }, [section, busy, refreshKey]);

  if (!info || info.bytes === 0) return null;

  const post = (type: string) => VSCodeAPI().postMessage({ type, section });

  return (
    <div className='local-data-line'>
      <span>
        Stored on this device: {info.items.toLocaleString()} item{info.items === 1 ? '' : 's'} · {formatBytes(info.bytes)}
      </span>
      <button type='button' className='local-data-link' onClick={() => post(MESSAGE_TYPES.SOURCE_DATA_REVEAL)}>
        Show folder
      </button>
      {confirming ? (
        <>
          <span>Delete it? The next sync downloads it again.</span>
          <button
            type='button'
            className='local-data-link local-data-danger'
            onClick={() => {
              setConfirming(false);
              post(MESSAGE_TYPES.SOURCE_DATA_DELETE);
            }}
          >
            Delete
          </button>
          <button type='button' className='local-data-link' onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type='button' className='local-data-link' disabled={busy} onClick={() => setConfirming(true)}>
          Delete local copy
        </button>
      )}
    </div>
  );
};

export default LocalDataLine;
