import React, { useEffect, useRef, useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
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

  // Nothing to show until a PR exists; an unavailable reason (no gh) is only
  // surfaced once there is a PR-shaped reason to care, never as noise.
  if (!snapshot?.pr) return null;
  const { pr, state, checks } = snapshot;
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
            {checks.length > 0 && <span className='ci-menu-count'>{checks.length}</span>}
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
          <label className='ci-menu-option' title='When checks fail, the agent reads the log, fixes it, and pushes to this pull request’s branch. Up to 3 attempts.'>
            <input type='checkbox' checked={autoFix} onChange={(e) => setAutoFix(e.target.checked)} />
            Auto-fix CI failures
          </label>
          {state === 'failed' && (
            <button type='button' className='ci-menu-fix' disabled={busy || attempts >= MAX_CI_FIX_ATTEMPTS} onClick={() => { setOpen(false); onFixNow(); }}>
              Fix now{attempts > 0 ? ` (${attempts}/${MAX_CI_FIX_ATTEMPTS} tried)` : ''}
            </button>
          )}
          {autoFix && attempts > 0 && <div className='ci-menu-hint'>{attempts}/{MAX_CI_FIX_ATTEMPTS} fix attempts used on this pull request.</div>}
        </div>
      )}
    </div>
  );
};

export default CiChip;
