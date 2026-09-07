import React, { useState } from 'react';

export interface ContextUsage {
  usedTokens: number;
  windowTokens: number;
  usedPct: number;
  remainingPct: number;
  /** How many times this run has summarized itself to free room. */
  compactions: number;
}

interface ContextMeterProps {
  usage?: ContextUsage | null;
  modelId?: string | null;
  /** True while a turn is in flight — the number is live rather than the last one seen. */
  running?: boolean;
}

const KNOWN_WINDOWS: ReadonlyArray<{ match: RegExp; tokens: number }> = [
  { match: /\bclaude\b/i, tokens: 200_000 },
  { match: /\bgpt-4o|gpt-4\.1|o[34]-(mini|preview)|\bgpt-5/i, tokens: 128_000 },
  { match: /\bgemini-(1\.5|2|2\.5|3)/i, tokens: 1_000_000 },
  { match: /\bglm\b/i, tokens: 200_000 },
  { match: /\bminimax\b/i, tokens: 192_000 },
  { match: /\bdeepseek\b/i, tokens: 128_000 },
  { match: /\bqwen|llama|mistral|mixtral|gemma|phi-?[0-9]|codestral\b/i, tokens: 32_000 },
];
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MAX_MANAGED_WINDOW = 200_000;

function resolveWindow(modelId?: string | null): number {
  const id = String(modelId ?? '');
  if (id) {
    for (const entry of KNOWN_WINDOWS) {
      if (entry.match.test(id)) return Math.min(entry.tokens, MAX_MANAGED_WINDOW);
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** 128000 → "128k", 9800 → "9.8k", 450 → "450". */
function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  const k = n / 1_000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * Circular context meter in the composer toolbar (Cursor / Claude Code style).
 * Quiet ghost ring next to send — no boxed chrome, no native title tooltip.
 * Color coding:
 * - normal (< 75%): muted
 * - warning (>= 75%): amber (auto-summarization threshold)
 * - critical (>= 90%): red (near exhaustion)
 */
const ContextMeter: React.FC<ContextMeterProps> = ({ usage, modelId, running = false }) => {
  const [isOpen, setIsOpen] = useState(false);

  const windowTokens =
    usage?.windowTokens && usage.windowTokens > 0
      ? usage.windowTokens
      : resolveWindow(modelId);

  const usedTokens = usage?.usedTokens ?? 0;
  const compactions = usage?.compactions ?? 0;

  const computedPct = windowTokens > 0 ? Math.round((usedTokens / windowTokens) * 100) : 0;
  const usedPct = usage?.usedPct !== undefined ? usage.usedPct : computedPct;
  const clamped = Math.min(100, Math.max(0, usedPct));

  const tone = clamped >= 90 ? 'critical' : clamped >= 75 ? 'warn' : 'ok';

  // Presentation attributes, not CSS `stroke` — same pattern as the paperclip.
  // VS Code webviews often don't paint CSS stroke on SVG, and --wgpt-border
  // is frequently transparent, which made the empty ring disappear entirely.
  const fillStroke =
    tone === 'critical'
      ? 'var(--vscode-editorError-foreground, #f14c4c)'
      : tone === 'warn'
        ? 'var(--vscode-editorWarning-foreground, #cca700)'
        : 'currentColor';

  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  // Keep a short rest arc at 0% so the control reads as a gauge, not a blank slot.
  const visualPct = Math.max(clamped, 12);
  const strokeDashoffset = circumference - (visualPct / 100) * circumference;

  const summaryLabel = `Context ${clamped}% · ${formatTokens(usedTokens)} of ${formatTokens(windowTokens)}`;

  return (
    <div
      className={`context-meter-container context-meter--${tone}${running ? ' context-meter--running' : ''}${isOpen ? ' context-meter--open' : ''}`}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        type='button'
        className='context-meter-btn'
        aria-label={summaryLabel}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
      >
        <svg
          className='context-meter-svg'
          width='18'
          height='18'
          viewBox='0 0 18 18'
          fill='none'
          xmlns='http://www.w3.org/2000/svg'
          aria-hidden='true'
        >
          <circle
            cx='9'
            cy='9'
            r={radius}
            fill='none'
            stroke='currentColor'
            strokeOpacity='0.28'
            strokeWidth='2.25'
          />
          <circle
            className='context-meter-circle-fill'
            cx='9'
            cy='9'
            r={radius}
            fill='none'
            stroke={fillStroke}
            strokeWidth='2.25'
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap='round'
            transform='rotate(-90 9 9)'
          />
        </svg>
      </button>

      <div className='context-meter-popover' role='tooltip'>
        <div className='context-meter-popover-header'>
          <span className='context-meter-popover-title'>Context</span>
          <span className={`context-meter-popover-badge context-meter-popover-badge--${tone}`}>
            {clamped}%
          </span>
        </div>

        <div className='context-meter-popover-bar'>
          <div
            className={`context-meter-popover-bar-fill context-meter-popover-bar-fill--${tone}`}
            style={{ width: `${clamped}%` }}
          />
        </div>

        <div className='context-meter-popover-usage'>
          {formatTokens(usedTokens)} / {formatTokens(windowTokens)}
          <span className='context-meter-popover-sub'> tokens</span>
        </div>

        <div className='context-meter-popover-footer'>
          {running && (
            <div className='context-meter-popover-live'>
              <span className='context-meter-live-dot' aria-hidden='true' /> Updating
            </div>
          )}
          {compactions > 0 ? (
            <div className='context-meter-popover-note context-meter-popover-note--compact'>
              Summarized {compactions === 1 ? 'once' : `${compactions} times`} to keep going
            </div>
          ) : clamped >= 90 ? (
            <div className='context-meter-popover-note context-meter-popover-note--critical'>
              Nearly full — will auto-compact or wrap up soon
            </div>
          ) : (
            <div className='context-meter-popover-note'>
              At 75% the run summarizes itself and continues
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ContextMeter;
