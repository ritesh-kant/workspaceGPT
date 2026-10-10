import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../../vscode';
import { MESSAGE_TYPES } from '../../constants';
import SectionShell from './SectionShell';

interface Entry {
  name: string;
  kind: 'preference' | 'style' | 'context';
  text: string;
  updated: string;
}

const KIND_LABEL: Record<Entry['kind'], string> = { preference: 'Preference', style: 'Style', context: 'Context' };

/**
 * What WorkspaceGPT has learned about how you work. Everything it remembers is
 * listed here, editable and removable, and the whole feature can be switched
 * off — in which case nothing is replayed into prompts and the agent is not
 * even offered the save tool. Stored on this machine only.
 */
const MemorySettings: React.FC = () => {
  const [state, setState] = useState<{ enabled: boolean; entries: Entry[] } | null>(null);
  const [editing, setEditing] = useState<{ name: string; text: string } | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.MEMORY_STATE) setState({ enabled: m.enabled, entries: m.entries ?? [] });
    };
    window.addEventListener('message', onMessage);
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.MEMORY_GET });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const post = (message: Record<string, unknown>) => VSCodeAPI().postMessage(message);
  const entries = [...(state?.entries ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  function saveEdit(entry: Entry) {
    if (editing && editing.text.trim()) post({ type: MESSAGE_TYPES.MEMORY_SAVE, name: entry.name, kind: entry.kind, text: editing.text });
    setEditing(null);
  }

  return (
    <SectionShell
      storageKey='memory'
      title='Memory'
      defaultOpen
      summary={state ? (state.enabled ? `${entries.length} remembered` : 'Off') : undefined}
    >
      <div className='settings-form'>
        <div className='form-group'>
          <label>
            <input
              type='checkbox'
              checked={state?.enabled ?? true}
              disabled={!state}
              onChange={(e) => post({ type: MESSAGE_TYPES.MEMORY_SET_ENABLED, enabled: e.target.checked })}
            />{' '}
            Remember my preferences and working style
          </label>
          <span className='import-detail'>
            WorkspaceGPT saves short notes when you state or correct a lasting preference. They are kept on this machine,
            never include your Knowledge content or secrets, and add about 600 tokens at most to a request.
          </span>
        </div>

        {state && entries.length === 0 && (
          <span className='import-detail'>
            Nothing remembered yet. Tell WorkspaceGPT how you like to work, for example “always use pnpm”, and it will
            appear here.
          </span>
        )}

        {entries.map((entry) => (
          <div className='import-row' key={entry.name}>
            <div className='import-text'>
              <span className='import-name'>
                {entry.name} <span className='import-detail'>· {KIND_LABEL[entry.kind]}</span>
              </span>
              {editing?.name === entry.name ? (
                <textarea
                  className='settings-input'
                  rows={2}
                  maxLength={200}
                  value={editing.text}
                  autoFocus
                  onChange={(e) => setEditing({ name: entry.name, text: e.target.value })}
                />
              ) : (
                <span className='import-detail'>{entry.text}</span>
              )}
            </div>
            {editing?.name === entry.name ? (
              <>
                <button type='button' className='secondary-button' onClick={() => saveEdit(entry)}>
                  Save
                </button>
                <button type='button' className='secondary-button' onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type='button' className='secondary-button' onClick={() => setEditing({ name: entry.name, text: entry.text })}>
                  Edit
                </button>
                <button
                  type='button'
                  className='secondary-button'
                  aria-label={`Forget ${entry.name}`}
                  onClick={() => post({ type: MESSAGE_TYPES.MEMORY_DELETE, name: entry.name })}
                >
                  Forget
                </button>
              </>
            )}
          </div>
        ))}

        {entries.length > 0 &&
          (confirmingClear ? (
            <div className='import-row'>
              <span className='import-detail'>Forget everything WorkspaceGPT remembers about you?</span>
              <button type='button' className='secondary-button' onClick={() => setConfirmingClear(false)}>
                Cancel
              </button>
              <button
                type='button'
                className='danger-button danger-button--small'
                onClick={() => {
                  post({ type: MESSAGE_TYPES.MEMORY_CLEAR });
                  setConfirmingClear(false);
                }}
              >
                Forget all
              </button>
            </div>
          ) : (
            <div>
              <button type='button' className='danger-button danger-button--small' onClick={() => setConfirmingClear(true)}>
                Forget all
              </button>
            </div>
          ))}
      </div>
    </SectionShell>
  );
};

export default MemorySettings;
