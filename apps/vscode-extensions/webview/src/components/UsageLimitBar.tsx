import React, { useState } from 'react';
import { formatDurationApprox, nextWeeklyReset, usageTone } from '../utils/usage';

interface UsageLimitBarProps {
  /** Credits used / allowed this week. */
  used: number;
  limit: number;
  /** Credits used / allowed in the rolling window; absent on an older server. */
  windowUsed?: number;
  windowLimit?: number;
  windowSeconds?: number;
}

const DISMISS_KEY = 'workspacegpt.usageLimitDismissedForReset';
/** Bar shows once this little of the weekly quota is left (i.e. 75%+ used). */
const SHOW_AT_REMAINING_PCT = 25;

function readDismissedReset(): number | null {
  try {
    const stored = localStorage.getItem(DISMISS_KEY);
    return stored ? Number(stored) : null;
  } catch {
    return null;
  }
}

function formatResetDate(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Dismissible warning once the weekly remote-mode quota (RemoteAccountSettings.tsx's
 * WeeklyUsageRow, surfaced here near the composer instead of only in Settings)
 * runs low. Dismissing suppresses it for the rest of the current quota week —
 * it reappears once the quota resets, same as a real limit warning should.
 */
const UsageLimitBar: React.FC<UsageLimitBarProps> = ({ used, limit, windowUsed, windowLimit, windowSeconds }) => {
  const resetAt = nextWeeklyReset();
  const [dismissedReset, setDismissedReset] = useState<number | null>(readDismissedReset);

  if (limit <= 0) return null;
  const pctLeft = (u: number, l: number) => Math.min(100, Math.max(0, Math.round(((l - u) / l) * 100)));
  const weeklyPct = pctLeft(used, limit);
  const hasWindow = typeof windowLimit === 'number' && windowLimit > 0;
  const windowPct = hasWindow ? pctLeft(windowUsed ?? 0, windowLimit) : 100;
  // Two allowances, one bar: whichever is closer to running out is the one
  // worth warning about. The 5-hour window frees itself; the week does not.
  const windowIsTighter = hasWindow && windowPct < weeklyPct;
  const remainingPct = windowIsTighter ? windowPct : weeklyPct;
  if (remainingPct > SHOW_AT_REMAINING_PCT) return null;
  if (!windowIsTighter && dismissedReset === resetAt.getTime()) return null;

  const usedPct = 100 - remainingPct;
  const tone = usageTone(remainingPct);
  const label = windowIsTighter
    ? remainingPct === 0
      ? "You've used your 5-hour credit allowance"
      : `You've used ${usedPct}% of your 5-hour credit allowance`
    : remainingPct === 0
      ? "You've used your weekly credits"
      : `You've used ${usedPct}% of your weekly credits`;
  const resetText = windowIsTighter
    ? `Frees up in ${formatDurationApprox(windowSeconds ?? 5 * 3600)}`
    : `Resets ${formatResetDate(resetAt)}`;

  const dismiss = () => {
    const ts = resetAt.getTime();
    setDismissedReset(ts);
    try {
      localStorage.setItem(DISMISS_KEY, String(ts));
    } catch {
      // Non-persistent storage: dismissed for this session only.
    }
  };

  return (
    <div className={`usage-limit-bar usage-limit-bar--${tone}`} role='status'>
      <span className='usage-limit-icon' aria-hidden='true'>
        <svg width='13' height='13' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <path
            d='M12 9v4m0 4h.01M10.29 3.86L1.82 18a1 1 0 0 0 .86 1.5h18.64a1 1 0 0 0 .86-1.5L13.71 3.86a1 1 0 0 0-1.72 0Z'
            stroke='currentColor'
            strokeWidth='2'
            strokeLinecap='round'
            strokeLinejoin='round'
          />
        </svg>
      </span>
      <span className='usage-limit-text'>{label}</span>
      <span className='usage-limit-reset'>{resetText}</span>
      <button type='button' className='usage-limit-dismiss' onClick={dismiss} aria-label='Dismiss'>
        <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <path d='M6 6l12 12M18 6L6 18' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
        </svg>
      </button>
    </div>
  );
};

export default UsageLimitBar;
