import React, { useEffect, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { folderName, sameFolder } from '../hooks/useWorkspaceFolders';
import { FolderIcon } from './WorkspaceControls';

interface FolderSwitchDialogProps {
  /** What is being started, e.g. "#1537001 Venmo payment method for US". */
  subject: string;
  /** The folder open now; '' when none. */
  current: string;
  /** Settings → Default folder; '' when unset. */
  defaultFolder: string;
  /** Folders this app has opened, offered when no default is set yet. */
  recent: string[];
  home: string;
  /** Sent with the switch; the page that loads in the new folder picks it up. */
  resume: unknown;
  /** A chat is running: the host refuses to switch folders under it. */
  busy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Starting a ticket outside the default folder, or before one is set: one
 * question, "where should this run?", answered by picking a folder. The open
 * folder starts right away; any other opens first, which reloads the host, so
 * the start travels with it (`resume`) and runs on the other side. With no
 * default yet, the pick can also be remembered as the default.
 */
const FolderSwitchDialog: React.FC<FolderSwitchDialogProps> = ({
  subject,
  current,
  defaultFolder,
  recent,
  home,
  resume,
  busy,
  onContinue,
  onCancel,
}) => {
  // Fixed at open: saving a default re-sends the folders, and the dialog must
  // not turn into the other question halfway through.
  const [askToSet] = useState(() => !defaultFolder);
  const [choices] = useState(() =>
    askToSet ? [...new Set([current, ...recent].filter(Boolean))] : [defaultFolder, current].filter(Boolean)
  );
  const [selected, setSelected] = useState(() => (askToSet ? current || choices[0] || '' : defaultFolder));
  const [remember, setRemember] = useState(true);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'opening'>('idle');
  const [error, setError] = useState<string | null>(null);

  const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  const parentOf = (p: string) => tilde(p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')) || '/';
  const selectedIsOpen = sameFolder(selected, current);
  const selectedName = selected ? folderName(selected) : '';

  const start = () => {
    if (selectedIsOpen) {
      onContinue();
      return;
    }
    setPhase('opening');
    VSCodeAPI().postMessage({ type: MESSAGE_TYPES.OPEN_WORKSPACE_FOLDER, path: selected, resume });
  };

  const confirm = () => {
    setError(null);
    if (askToSet && remember && selected) {
      setPhase('saving');
      VSCodeAPI().postMessage({ type: MESSAGE_TYPES.SET_DEFAULT_FOLDER, path: selected });
      return;
    }
    start();
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.DEFAULT_FOLDER_RESULT && phase === 'saving') {
        if (m.ok) start();
        else {
          setPhase('idle');
          setError(m.error || 'Could not use that folder.');
        }
        return;
      }
      // Success ends this page when the folder opens; only a refusal comes back.
      if (m?.type === MESSAGE_TYPES.WORKSPACE_ACTION_RESULT && m.action === 'switch-default-folder' && !m.ok) {
        setPhase('idle');
        setError(m.error || 'Could not open that folder.');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase === 'idle') onCancel();
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
  });

  const working = phase !== 'idle';
  const primaryLabel = !selected
    ? 'Choose a folder'
    : phase === 'opening'
      ? `Opening ${selectedName}…`
      : // The selected row above names the folder; a long name in the
        // button only truncated.
        selectedIsOpen
        ? 'Start here'
        : 'Switch and start';
  // Only a folder that is not open needs the switch, and a running chat blocks that.
  const blockedByRun = busy && !!selected && !selectedIsOpen;

  return (
    <div
      className='mode-confirm-overlay'
      role='dialog'
      aria-modal='true'
      aria-labelledby='folder-switch-title'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !working) onCancel();
      }}
    >
      <div className='folder-switch-dialog'>
        <header className='folder-switch-head'>
          <h3 id='folder-switch-title'>{askToSet ? 'Where should this ticket run?' : 'Switch to your default folder?'}</h3>
          <p className='folder-switch-subject' title={subject}>
            {subject}
          </p>
        </header>

        <div className='folder-switch-choices' role='radiogroup' aria-labelledby='folder-switch-title'>
          {choices.map((p) => {
            const isOpen = sameFolder(p, current);
            const isDefault = sameFolder(p, defaultFolder);
            return (
              <label
                key={p}
                className={`folder-choice${sameFolder(p, selected) ? ' folder-choice--selected' : ''}`}
                title={tilde(p)}
              >
                <input
                  type='radio'
                  name='folder-switch-choice'
                  checked={sameFolder(p, selected)}
                  onChange={() => setSelected(p)}
                  disabled={working}
                />
                <span className='folder-choice-icon'>
                  <FolderIcon />
                </span>
                <span className='folder-choice-text'>
                  <span className='folder-choice-name'>{folderName(p)}</span>
                  <span className='folder-choice-path'>{parentOf(p)}</span>
                </span>
                {isDefault && <span className='folder-choice-badge folder-choice-badge--default'>Default</span>}
                {isOpen && <span className='folder-choice-badge'>Open now</span>}
              </label>
            );
          })}
          {choices.length === 0 && (
            <p className='folder-switch-note'>No folders yet. Open one, or set it in Settings → Default folder.</p>
          )}
        </div>

        {askToSet && choices.length > 0 && (
          <label className='folder-switch-remember'>
            <input type='checkbox' checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={working} />
            <span>
              Remember as my default folder
              <span className='folder-switch-remember-hint'>Change it anytime in Settings.</span>
            </span>
          </label>
        )}

        {!selectedIsOpen && selected && !blockedByRun && (
          <p className='folder-switch-note'>Opens {selectedName} in this window, and the ticket continues there.</p>
        )}
        {blockedByRun && (
          <p className='folder-switch-note'>A chat is still running. Switching folders waits until it finishes.</p>
        )}
        {error && (
          <p className='folder-switch-note folder-switch-note--error' role='alert'>
            {error}
          </p>
        )}

        <div className='folder-switch-actions'>
          <button type='button' className='folder-switch-cancel' onClick={onCancel} disabled={working}>
            Cancel
          </button>
          <button
            type='button'
            className='folder-switch-primary'
            onClick={confirm}
            disabled={!selected || working || blockedByRun}
            title={primaryLabel}
            autoFocus
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderSwitchDialog;
