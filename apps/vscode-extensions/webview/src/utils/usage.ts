/**
 * Weekly remote-mode quota math, shared by the Settings account row
 * (RemoteAccountSettings.tsx) and the composer's usage-limit bar
 * (UsageLimitBar.tsx) — extracted so both read the same reset clock and
 * tone thresholds instead of drifting apart.
 */

/** Next Monday 00:00 UTC — same reset the Worker uses in usage.ts. */
export function nextWeeklyReset(now = new Date()): Date {
  const isoDayNumber = now.getUTCDay() || 7; // Mon=1 … Sun=7
  const daysUntilMonday = 8 - isoDayNumber;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
}

export function formatRefreshIn(now = new Date()): string {
  const ms = Math.max(0, nextWeeklyReset(now).getTime() - now.getTime());
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** "about 2 hours" / "about 15 minutes" — for the rolling-window allowance. */
export function formatDurationApprox(seconds: number): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `about ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export function usageTone(remainingPct: number): 'ok' | 'warn' | 'critical' {
  if (remainingPct <= 10) return 'critical';
  if (remainingPct <= 25) return 'warn';
  return 'ok';
}
