import React from 'react';

export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  usedPct: number;
  remainingPct: number;
  /** How many times this run has summarized itself to free room. */
  compactions: number;
}

interface ContextMeterProps {
  usage: ContextUsage;
  /** True while a turn is in flight — the number is live rather than the last one seen. */
  running: boolean;
}

/** 128000 → "128k", 9800 → "9.8k". */
function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const k = n / 1_000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * How much of the model's context window the current run occupies.
 *
 * Worth showing for the same reason Claude Code shows it: since the turn cap
 * was removed, THIS is the thing that bounds a run, and it is no longer a
 * number the user should have to infer from a run ending badly. It is measured
 * — the provider reports `usage.prompt_tokens` on every completion — not
 * estimated from characters.
 *
 * Deliberately quiet until it matters: below 50% there is nothing to act on,
 * so the meter stays hidden rather than adding permanent furniture to the
 * composer. Crossing 75% is not a warning either — that is where the run
 * summarizes itself and carries on — so the copy says what happened rather
 * than implying the user must do something.
 */
const SHOW_FROM_PCT = 50;

const ContextMeter: React.FC<ContextMeterProps> = ({ usage, running }) => {
  const { usedPct, usedTokens, windowTokens, compactions } = usage;
  if (!windowTokens || usedPct < SHOW_FROM_PCT) return null;

  const tone = usedPct >= 90 ? 'critical' : usedPct >= 75 ? 'warn' : 'ok';
  const clamped = Math.min(100, Math.max(0, usedPct));
  const detail = `${formatTokens(usedTokens)} of ${formatTokens(windowTokens)} tokens`;
  const label =
    compactions > 0
      ? `Context ${usedPct}% · summarized ${compactions === 1 ? 'once' : `${compactions} times`} to keep going`
      : `Context ${usedPct}%`;

  return (
    <div
      className={`context-meter context-meter--${tone}`}
      role='status'
      aria-label={`${label}, ${detail}`}
      title={
        `${detail}. At 75% the run summarizes what it has learned and continues, ` +
        `so a long task is not cut short.`
      }
    >
      <span className='context-meter-bar' aria-hidden='true'>
        <span className='context-meter-fill' style={{ width: `${clamped}%` }} />
      </span>
      <span className='context-meter-label'>{label}</span>
      {running && <span className='context-meter-live' aria-hidden='true' />}
    </div>
  );
};

export default ContextMeter;
