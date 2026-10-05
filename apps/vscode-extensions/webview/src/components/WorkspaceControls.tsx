import React, { useEffect, useRef, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { useGitStatusStore } from '../store/gitStatusStore';

/**
 * Folder and branch chips under the composer on the new-chat screen (desktop
 * only — in VS Code the editor owns both). The folder chip lists the folders
 * this app has opened, takes a typed path, or opens the system picker; the
 * branch chip checks out a local branch or creates one. The host refuses both
 * while a chat is running (ChatMessageHandler.runWorkspaceAction).
 */

export interface MenuRow {
  key: string;
  label: string;
  subtitle?: string;
  selected?: boolean;
  onPick: () => void;
}

interface ChipMenuProps {
  icon: React.ReactNode;
  label: string;
  title: string;
  disabled?: boolean;
  searchPlaceholder: string;
  /** Rows for the current search text; the menu does no filtering of its own. */
  rows: (search: string) => MenuRow[];
  emptyLabel: string;
  footer?: { label: string; onClick: () => void };
  onOpen?: () => void;
  /** Closes the menu from outside, e.g. once a pick has gone through. */
  closeSignal: number;
}

export const ChipMenu: React.FC<ChipMenuProps> = ({
  icon,
  label,
  title,
  disabled,
  searchPlaceholder,
  rows,
  emptyLabel,
  footer,
  onOpen,
  closeSignal,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [closeSignal]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const visible = open ? rows(search) : [];
  // Rows can arrive after the menu opens (branches load on open), so the
  // current row's index is a dependency, not just open/search.
  const selectedIndex = visible.findIndex((r) => r.selected);
  useEffect(() => {
    setHighlighted(search ? 0 : Math.max(0, selectedIndex));
  }, [open, search, selectedIndex]);

  const toggle = () => {
    if (disabled) return;
    if (!open) {
      setSearch('');
      onOpen?.();
    }
    setOpen(!open);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      visible[highlighted]?.onPick();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className='workspace-chip-container' ref={ref}>
      <button
        type='button'
        className='workspace-chip'
        onClick={toggle}
        disabled={disabled}
        title={title}
        aria-haspopup='listbox'
        aria-expanded={open}
      >
        {icon}
        <span className='workspace-chip-label'>{label}</span>
      </button>
      {open && (
        <div className='searchable-dropdown-menu workspace-chip-menu' role='listbox' onKeyDown={onKeyDown}>
          <input
            type='text'
            className='searchable-dropdown-input'
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <ul className='searchable-dropdown-list'>
            {visible.map((row, i) => (
              <li
                key={row.key}
                className={`searchable-dropdown-item${row.selected ? ' selected' : ''}${i === highlighted ? ' highlighted' : ''}`}
                role='option'
                aria-selected={!!row.selected}
                title={row.subtitle}
                onClick={row.onPick}
                onMouseEnter={() => setHighlighted(i)}
              >
                <div className='item-title'>{row.label}</div>
                {row.subtitle && <div className='item-subtitle'>{row.subtitle}</div>}
              </li>
            ))}
            {visible.length === 0 && <li className='searchable-dropdown-empty'>{emptyLabel}</li>}
          </ul>
          {footer && (
            <button type='button' className='searchable-dropdown-footer' onClick={footer.onClick}>
              {footer.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export const FolderIcon = () => (
  <svg width='14' height='14' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
    <path
      d='M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinejoin='round'
    />
  </svg>
);

const BranchIcon = () => (
  <svg width='14' height='14' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
    <path
      d='M6 3v12M18 9a3 3 0 1 0-3-3M6 21a3 3 0 1 0 0-6M9 6a9 9 0 0 0 9 9'
      stroke='currentColor'
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
    />
  </svg>
);

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
export const looksLikePath = (s: string) => /^(~|\/|[a-zA-Z]:[\\/]|\\\\)/.test(s.trim());

interface WorkspaceControlsProps {
  /** A chat is running somewhere: switching now would change the files under it. */
  busy: boolean;
}

const WorkspaceControls: React.FC<WorkspaceControlsProps> = ({ busy }) => {
  const status = useGitStatusStore((s) => s.status);
  const [current, setCurrent] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [home, setHome] = useState('');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);
  const [useWorktree, setUseWorktree] = useState(false);

  useEffect(() => {
    const vscode = VSCodeAPI();
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.RECENT_FOLDERS) {
        setCurrent(m.current ?? '');
        setRecent(Array.isArray(m.recent) ? m.recent : []);
        setHome(m.home ?? '');
      } else if (m?.type === MESSAGE_TYPES.GIT_BRANCHES) {
        setBranches(Array.isArray(m.branches) ? m.branches : []);
        if (m.error) setError(m.error);
      } else if (m?.type === MESSAGE_TYPES.WORKSPACE_ACTION_RESULT) {
        // The folder-switch popup's own switch (FolderSwitchDialog.tsx) answers there.
        if (m.action === 'switch-default-folder') return;
        // A folder that opened ends this page (the window reloads), so keep
        // saying "Opening…" until it does. The picker answers when it closes,
        // picked or cancelled; a pick then reloads the same way.
        if (m.action === 'open-folder' && m.ok) return;
        setPending(null);
        if (m.ok) setCloseSignal((n) => n + 1);
        else setError(m.error || 'That did not work.');
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: MESSAGE_TYPES.GET_RECENT_FOLDERS });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  const send = (action: string, message: Record<string, unknown>) => {
    setError(null);
    setPending(action);
    VSCodeAPI().postMessage(message);
  };
  const openFolder = (path?: string) => {
    if (path !== undefined && path === current) return setCloseSignal((n) => n + 1);
    send(path === undefined ? 'pick-folder' : 'open-folder', { type: MESSAGE_TYPES.OPEN_WORKSPACE_FOLDER, path });
  };
  const switchBranch = (branch: string, create: boolean) => {
    if (!create && !useWorktree && branch === status?.branch) return setCloseSignal((n) => n + 1);
    send(useWorktree ? 'open-folder' : 'switch-branch', {
      type: MESSAGE_TYPES.SWITCH_GIT_BRANCH,
      branch,
      create,
      worktree: useWorktree,
    });
  };

  const folderRows = (search: string): MenuRow[] => {
    const q = search.trim().toLowerCase();
    const folders = [...new Set([current, ...recent].filter(Boolean))];
    const rows: MenuRow[] = folders
      .filter((p) => !q || p.toLowerCase().includes(q) || tilde(p).toLowerCase().includes(q))
      .map((p) => ({
        key: p,
        label: baseName(p),
        subtitle: tilde(p),
        selected: p === current,
        onPick: () => openFolder(p),
      }));
    if (looksLikePath(search)) {
      rows.unshift({ key: '\0typed', label: `Open “${search.trim()}”`, onPick: () => openFolder(search.trim()) });
    }
    return rows;
  };

  const branchRows = (search: string): MenuRow[] => {
    const q = search.trim();
    const all = branches ?? [];
    const rows: MenuRow[] = all
      .filter((b) => !q || b.toLowerCase().includes(q.toLowerCase()))
      .map((b) => ({ key: b, label: b, selected: b === status?.branch, onPick: () => switchBranch(b, false) }));
    if (q && !all.includes(q)) {
      rows.push({
        key: '\0create',
        label: useWorktree ? `Create branch “${q}” in a new worktree` : `Create branch “${q}”`,
        subtitle: useWorktree
          ? 'From the current commit, in its own folder; uncommitted changes stay here'
          : 'From the current commit; your uncommitted changes come along',
        onPick: () => switchBranch(q, true),
      });
    }
    return rows;
  };

  const busyTitle = 'Wait for the running chat to finish';
  const disabled = busy || pending !== null;

  return (
    <div className='workspace-controls'>
      <div className='workspace-controls-row'>
        <ChipMenu
          icon={<FolderIcon />}
          label={pending === 'open-folder' ? 'Opening…' : current ? baseName(current) : 'Open a folder'}
          title={busy ? busyTitle : current ? tilde(current) : 'Pick the folder the agent works in'}
          disabled={disabled}
          searchPlaceholder='Search folders, or type a path'
          rows={folderRows}
          emptyLabel='No folders yet. Type a path or use Open folder…'
          footer={{ label: 'Open folder…', onClick: () => openFolder(undefined) }}
          onOpen={() => {
            setError(null);
            VSCodeAPI().postMessage({ type: MESSAGE_TYPES.GET_RECENT_FOLDERS });
          }}
          closeSignal={closeSignal}
        />
        {status?.isRepo && (
          <ChipMenu
            icon={<BranchIcon />}
            label={pending === 'switch-branch' ? 'Switching…' : pending === 'open-folder' ? 'Opening…' : status.branch || 'detached'}
            title={busy ? busyTitle : `Branch: ${status.branch || 'detached HEAD'}`}
            disabled={disabled}
            searchPlaceholder='Search or create a branch'
            rows={branchRows}
            emptyLabel={branches === null ? 'Loading…' : 'No branches'}
            onOpen={() => {
              setError(null);
              setBranches(null);
              VSCodeAPI().postMessage({ type: MESSAGE_TYPES.LIST_GIT_BRANCHES });
            }}
            closeSignal={closeSignal}
          />
        )}
        {status?.isRepo && (
          <label
            className='workspace-worktree-toggle'
            title='Pick or create a branch in its own git worktree, so this folder is left as it is'
          >
            <input
              type='checkbox'
              checked={useWorktree}
              disabled={disabled}
              onChange={(e) => setUseWorktree(e.target.checked)}
            />
            worktree
          </label>
        )}
      </div>
      {error && (
        <div className='workspace-controls-error' role='alert'>
          {error}
        </div>
      )}
    </div>
  );
};

export default WorkspaceControls;
