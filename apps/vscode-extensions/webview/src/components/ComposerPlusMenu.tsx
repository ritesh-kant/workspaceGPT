import React, { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../store/uiStore';

interface Props {
  onAddFiles: () => void;
  onAddFolder: () => void;
  filesDisabled: boolean;
  /** Connectors steer Desktop Work-mode runs; elsewhere the menu has only the add rows. */
  showConnectors: boolean;
}

const Icon: React.FC<{ d: string }> = ({ d }) => (
  <svg width='15' height='15' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
    <path d={d} />
  </svg>
);

/**
 * The composer's "+" menu: add files or a folder, and Connectors, which opens
 * Settings on the Connectors page where Control Chrome is switched on and its
 * Chrome extension installed.
 */
const ComposerPlusMenu: React.FC<Props> = ({ onAddFiles, onAddFolder, filesDisabled, showConnectors }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openSettings = useUiStore((s) => s.openSettings);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className='plus-menu' ref={ref}>
      <button
        type='button'
        className='attach-button action-btn'
        onClick={() => setOpen((v) => !v)}
        title='Add files, folders and connectors'
        aria-label='Add files, folders and connectors'
        aria-haspopup='menu'
        aria-expanded={open}
      >
        <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' aria-hidden>
          <path d='M12 5v14M5 12h14' />
        </svg>
      </button>
      {open && (
        <div className='plus-menu-popover' role='menu'>
          <button type='button' role='menuitem' className='plus-menu-row' disabled={filesDisabled} onClick={() => pick(onAddFiles)}>
            <Icon d='M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' />
            Add files or photos
          </button>
          <button type='button' role='menuitem' className='plus-menu-row' onClick={() => pick(onAddFolder)}>
            <Icon d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' />
            Add folder
          </button>
          {showConnectors && (
            <button type='button' role='menuitem' className='plus-menu-row' onClick={() => pick(() => openSettings('connectors'))}>
              <Icon d='M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6h-6zM4 14h6v6H4z' />
              Connectors
              <span className='plus-menu-chevron'>›</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default ComposerPlusMenu;
