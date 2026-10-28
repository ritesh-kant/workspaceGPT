import React, { useEffect, useRef, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { useGitStatusStore } from '../store/gitStatusStore';

/**
 * Project selector and workspace settings in the composer footer (desktop
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
  enabled: boolean;
}

export const useWorkspaceControls = ({ busy, enabled }: WorkspaceControlsProps) => {
  const status = useGitStatusStore((s) => s.status);
  const [current, setCurrent] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [home, setHome] = useState('');
  const [branches, setBranches] = useState<string[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closeSignal, setCloseSignal] = useState(0);
  const [useWorktree, setUseWorktree] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [settingsOpen]);

  useEffect(() => setSettingsOpen(false), [closeSignal, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const vscode = VSCodeAPI();
    const onMessage = (event: MessageEvent) => {
      const m = event.data;
      if (m?.type === MESSAGE_TYPES.RECENT_FOLDERS) {
        // The folder the chat on screen works in, which need not be the window's open one.
        setCurrent(m.viewed || m.current || '');
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
  }, [enabled]);

  const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  const send = (action: string, message: Record<string, unknown>) => {
    setError(null);
    setPending(action);
    VSCodeAPI().postMessage(message);
  };
  const openFolder = (path?: string) => {
    if (path !== undefined && path === current) return setCloseSignal((n) => n + 1);
    // Only this chat's folder changes: the host is not restarted, so chats already running are untouched.
    send('set-folder', { type: MESSAGE_TYPES.SET_NEW_CHAT_FOLDER, path });
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

  const project = enabled ? (
    <div className='workspace-project-selector'>
      <ChipMenu
        icon={<FolderIcon />}
        label={pending === 'set-folder' ? 'Opening…' : current ? baseName(current) : 'Open a folder'}
        title={current ? `Change project: ${tilde(current)}` : 'Select a project folder'}
        disabled={pending !== null}
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
    </div>
  ) : null;

  const settings = enabled ? (
    <div className='workspace-settings' ref={settingsRef} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setSettingsOpen(false);
        settingsButtonRef.current?.focus();
      }
    }}>
      <button
        ref={settingsButtonRef}
        type='button'
        className='workspace-settings-trigger'
        title='Workspace settings'
        aria-label='Workspace settings'
        aria-haspopup='dialog'
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((open) => !open)}
      >
        <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.7' aria-hidden='true'>
          <path d='m9 3-.6 2.4-2 .9L4.1 5.5 2 9.1l1.8 1.7v2.4L2 14.9l2.1 3.6 2.3-.8 2 .9L9 21h6l.6-2.4 2-.9 2.3.8 2.1-3.6-1.8-1.7v-2.4L22 9.1l-2.1-3.6-2.3.8-2-.9L15 3z' />
          <circle cx='12' cy='12' r='3' />
        </svg>
      </button>
      {settingsOpen && (
        <div className='workspace-settings-menu' role='dialog' aria-label='Workspace settings'>
          <h3>Workspace settings</h3>
          {status?.isRepo ? (
            <>
              <label className='workspace-settings-row'>
                <span>New worktree</span>
                <input
                  type='checkbox'
                  role='switch'
                  checked={useWorktree}
                  disabled={disabled}
                  onChange={(event) => setUseWorktree(event.target.checked)}
                  title='Pick or create a branch in its own worktree; uncommitted changes stay here'
                />
              </label>
              <div className='workspace-settings-row workspace-settings-branch'>
                <span>Branch</span>
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
              </div>
              <p>Applies to this project</p>
            </>
          ) : <p>Open a Git repository to configure branches and worktrees.</p>}
          {error && <div className='workspace-controls-error' role='alert'>{error}</div>}
        </div>
      )}
      {error && !settingsOpen && <div className='workspace-settings-error' role='alert'>{error}</div>}
    </div>
  ) : null;

  return { projectControl: project, workspaceSettings: settings };
};
