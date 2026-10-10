import React, { useEffect, useRef, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { useGitStatusStore } from '../store/gitStatusStore';
import { useUiStore } from '../store';
import { useCodeHostConnected } from '../hooks/useCodeHostConnected';
import { MAX_CI_FIX_ATTEMPTS, useCiStore, type CiStateName } from '../store/ciStore';

const LABEL: Record<CiStateName, string> = {
  none: 'No checks',
  pending: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  merged: 'Merged',
  closed: 'Closed',
  unavailable: 'Unavailable',
};

/**
 * The pull request on this chat's branch and its CI, under the git status
 * bar: "#52 branch  CI ●". The dropdown lists the checks and holds the
 * Auto-fix switch (see useCiSync for the cycle it turns on).
 */
const CiChip: React.FC<{ onFixNow: () => void }> = ({ onFixNow }) => {
  const snapshot = useCiStore((s) => s.snapshot);
  const autoFix = useCiStore((s) => s.autoFix);
  const phase = useCiStore((s) => s.phase);
  const note = useCiStore((s) => s.note);
  const attempts = useCiStore((s) => (s.snapshot?.pr ? (s.attempts[s.snapshot.pr.number] ?? 0) : 0));
  const setAutoFix = useCiStore((s) => s.setAutoFix);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const branch = useGitStatusStore((s) => s.status?.branch);
  const hostConnected = useCodeHostConnected();
  const openSettings = useUiStore((s) => s.openSettings);
  // Nothing to show until an open PR exists. The exception is a GitHub-shaped repo
  // whose PR can't be looked up: then the row is a skeleton that says why and
  // offers the fix, off the default branches so it isn't noise on every branch.
  if (!snapshot?.pr) {
    if (snapshot?.state === 'unavailable' && snapshot.reason && branch && !/^(main|master)$/.test(branch) && hostConnected !== null) {
      return (
        <div className='ci-chip-row'>
          <span className='ci-chip ci-chip--none' aria-hidden='true'><span className='ci-dot' />CI</span>
          <span className='ci-chip-note' title={snapshot.reason}>{hostConnected ? snapshot.reason : "Connect your code host to see this branch's PR checks"}</span>
          {!hostConnected && (
            <button type='button' className='ci-chip-pr' onClick={() => openSettings('codehost')}>
              Connect code host →
            </button>
          )}
        </div>
      );
    }
    return null;
  }
  const { pr, state } = snapshot;
  // A merged or closed PR is history, not this branch's work in flight; on main it is
  // an old PR that once had this head name. CI only matters while the PR is live.
  if (state === 'merged' || state === 'closed') return null;
  // What needs a look first: the list scrolls, so failures must not hide below the fold.
  const rank = { fail: 0, pending: 1, pass: 2 } as const;
  const checks = [...snapshot.checks].sort((a, b) => rank[a.state] - rank[b.state]);
  const failing = checks.filter((c) => c.state === 'fail').length;
  const busy = phase !== 'idle';
  const openPr = () => VSCodeAPI().postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: pr.url });

  return (
    <div className='ci-chip-row' ref={ref}>
      <button type='button' className='ci-chip-pr' onClick={openPr} title={`Open pull request #${pr.number}`}>
        #{pr.number}
      </button>
      <span className='ci-chip-branch'>{pr.branch}</span>
      <span className='ci-chip-note'>
        {phase === 'fixing' ? 'Fixing CI…' : phase === 'pushing' ? 'Pushing the fix…' : note}
      </span>
      <button type='button' className={`ci-chip ci-chip--${state}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className='ci-dot' />
        CI
        <span className='ci-caret'>▾</span>
      </button>
      {open && (
        <div className='ci-menu' role='dialog' aria-label='CI monitoring'>
          <div className='ci-menu-title'>CI monitoring</div>
          <div className={`ci-menu-state ci-chip--${state}`}>
            <span className='ci-dot' />
            {LABEL[state]}
            {checks.length > 0 && (
              <span className='ci-menu-count'>
                {failing > 0 ? `${failing} failing · ` : ''}
                {checks.length} checks
              </span>
            )}
          </div>
          {checks.length > 0 && (
            <ul className='ci-checks'>
              {checks.map((c, i) => (
                <li key={`${c.name}-${i}`} className={`ci-check ci-check--${c.state}`}>
                  <span className='ci-dot' />
                  {c.url ? (
                    <a href={c.url} onClick={(e) => { e.preventDefault(); VSCodeAPI().postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: c.url }); }}>{c.name}</a>
                  ) : (
                    c.name
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className='ci-menu-footer'>
            <label className='ci-menu-option' title='When checks fail, the agent reads the log, fixes it, and pushes to this pull request’s branch. Up to 3 attempts.'>
              <input type='checkbox' checked={autoFix} onChange={(e) => setAutoFix(e.target.checked)} />
              Auto-fix CI failures
            </label>
            {state === 'failed' && (
              <button type='button' className='ci-menu-fix' disabled={busy || attempts >= MAX_CI_FIX_ATTEMPTS} onClick={() => { setOpen(false); onFixNow(); }}>
                Fix now{attempts > 0 ? ` (${attempts}/${MAX_CI_FIX_ATTEMPTS} tried)` : ''}
              </button>
            )}
          </div>
          {autoFix && attempts > 0 && <div className='ci-menu-hint'>{attempts}/{MAX_CI_FIX_ATTEMPTS} fix attempts used on this pull request.</div>}
        </div>
      )}
    </div>
  );
};

export default CiChip;
