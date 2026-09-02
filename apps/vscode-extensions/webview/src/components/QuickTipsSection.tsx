import React, { useState } from 'react';

interface QuickTipsSectionProps {
  isConfluenceConnected: boolean;
  /** Sessions the user has already had — the tip retires once they have a few. */
  sessionCount: number;
  onOpenSettings: () => void;
}

const DISMISSED_KEY = 'workspacegpt.homeTipDismissed';
/** After this many chats the user has found their feet; stop showing tips. */
const RETIRE_AFTER_SESSIONS = 3;

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * One tip at a time, dismissible, gone for good once the user has sent a few
 * chats.
 *
 * The previous version stacked three always-expanded cards — a privacy
 * paragraph, a Confluence nudge, and a "you can ask for code changes" note —
 * which pushed the composer down on every launch. The privacy note now lives
 * on the Remote/Local chip in the composer, where the user looks when they
 * wonder where their data goes; what remains here is the single most useful
 * next step for this workspace.
 */
const QuickTipsSection: React.FC<QuickTipsSectionProps> = ({
  isConfluenceConnected,
  sessionCount,
  onOpenSettings,
}) => {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  if (dismissed || sessionCount >= RETIRE_AFTER_SESSIONS) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      // Non-persistent storage: dismissed for this session only.
    }
  };

  const tip = !isConfluenceConnected
    ? {
        text: 'Connect Confluence to ground answers in your team’s docs.',
        action: 'Open Settings',
        onAction: onOpenSettings,
      }
    : {
        text: 'Ask for a code change, not just an explanation. Every edit is a diff you approve first, and always revertable.',
      };

  return (
    <div className='home-tip' role='note'>
      <span className='home-tip-icon' aria-hidden='true'>
        <svg width='14' height='14' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <path d='M9 18h6M10 21h4' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
          <path
            d='M12 3a6 6 0 0 0-3.5 10.9c.6.5.9 1 1 1.6l.2 1.5h4.6l.2-1.5c.1-.6.4-1.1 1-1.6A6 6 0 0 0 12 3z'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinejoin='round'
          />
        </svg>
      </span>
      <span className='home-tip-text'>{tip.text}</span>
      {tip.action && (
        <button type='button' className='home-tip-action' onClick={tip.onAction}>
          {tip.action}
        </button>
      )}
      <button type='button' className='home-tip-dismiss' onClick={dismiss} aria-label='Dismiss tip'>
        <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <path d='M6 6l12 12M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
        </svg>
      </button>
    </div>
  );
};

export default QuickTipsSection;
