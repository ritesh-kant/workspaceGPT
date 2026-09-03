import React, { useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { AgentStep, normalizeAgentStep } from '../store/chatStore';

/**
 * Compact agent timeline, matching how Cursor / Claude Code present a turn:
 * exploration is one collapsed "Explored N …" disclosure, and command stdout
 * stays behind "Show output". Mutations (edits, commands) stay as one-line
 * rows so the user can still see what changed. Per-step model latency isn't
 * shown at all — the turn's total elapsed time is a separate, always-visible
 * label in the message footer (see ChatMessage), not part of this timeline.
 *
 * Live and done use the same collapsed defaults — expanding mid-run is how
 * the noise in the transcript used to happen. The loading indicator already
 * names the in-flight tool.
 */

interface AgentTimelineProps {
  steps: (AgentStep | string)[];
  /** Live mode: pulse the currently running step (once the user expands its group). */
  live?: boolean;
}

type Family = 'explore' | 'edit' | 'command';

type TimelineItem =
  | { type: 'group'; family: Family; steps: AgentStep[] }
  | { type: 'note'; step: AgentStep };

/**
 * Which steps collapse together. Reads/searches/checks are one family
 * ("Explored 3 files, 1 search"); edits and commands are their own, so a run
 * reads as "Edited 2 files · Ran 5 commands" instead of a flat list of every
 * individual call. Kinds outside these (notice) never reach here.
 */
function familyOf(kind: string): Family | null {
  if (kind === 'search' || kind === 'read' || kind === 'check' || kind === 'info') return 'explore';
  if (kind === 'edit') return 'edit';
  if (kind === 'command') return 'command';
  return null;
}

function groupSteps(steps: AgentStep[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const step of steps) {
    // Prose the model narrated alongside its tool calls is the connective
    // tissue of the trace ("Extension host is clean. Now the webview:") — it
    // renders inline between groups, not buried inside a collapsed
    // "Thought for Ns" disclosure where nobody ever found it.
    if (step.kind === 'note') {
      if (noteText(step)) items.push({ type: 'note', step });
      continue;
    }
    if (step.kind === 'thought') continue;
    const family = familyOf(step.kind);
    if (!family) continue;
    const last = items[items.length - 1];
    if (last && last.type === 'group' && last.family === family) {
      last.steps.push(step);
    } else {
      items.push({ type: 'group', family, steps: [step] });
    }
  }
  return items;
}

const EDIT_STAT_RE = /\+(\d+)\s+[−-](\d+)/;

/**
 * Done-mode compaction. Live, every step shows as it happens; once the turn
 * is over the transcript reads better as a summary:
 *  - bare "Thought for Ns" rows (no reasoning prose) are dropped — they only
 *    record per-turn latency, and each one split the exploration into a new
 *    "Explored 1 file" group (observed live: 12 alternating rows for one
 *    investigation);
 *  - consecutive edits to the same file (ignoring the dropped thoughts) fold
 *    into one row with the edit count and summed line stats.
 * Notes (agent prose) are kept — they are the reasoning worth reading.
 */
function compactDoneSteps(steps: AgentStep[]): AgentStep[] {
  const out: AgentStep[] = [];
  for (const step of steps) {
    if (step.kind === 'thought') continue;
    const last = out[out.length - 1];
    if (
      step.kind === 'edit' &&
      last?.kind === 'edit' &&
      last.path &&
      last.path === step.path &&
      last.title === step.title &&
      last.status !== 'error' &&
      step.status !== 'error'
    ) {
      const a = EDIT_STAT_RE.exec(last.summary ?? '');
      const b = EDIT_STAT_RE.exec(step.summary ?? '');
      const count = (last.meta as { editCount?: number } | undefined)?.editCount ?? 1;
      out[out.length - 1] = {
        ...last,
        detail: `${count + 1} edits`,
        summary:
          a && b ? `+${Number(a[1]) + Number(b[1])} −${Number(a[2]) + Number(b[2])}` : last.summary ?? step.summary,
        meta: { ...(last.meta ?? {}), editCount: count + 1 } as AgentStep['meta'],
      };
      continue;
    }
    out.push(step);
  }
  return out;
}

/** Summed "+a −r" across a set of edit steps, or '' when none carry stats. */
function sumEditStats(steps: AgentStep[]): string {
  let added = 0;
  let removed = 0;
  let any = false;
  for (const s of steps) {
    const m = EDIT_STAT_RE.exec(s.summary ?? '');
    if (!m) continue;
    any = true;
    added += Number(m[1]);
    removed += Number(m[2]);
  }
  return any ? `+${added} −${removed}` : '';
}

function exploreLabel(steps: AgentStep[]): string {
  // 'read' covers both file reads ("Analyzed") and directory listings
  // ("Explored") — split those out so the label can say "N files, M folders"
  // the way Antigravity's trace does, instead of lumping them together.
  const files = steps.filter((s) => s.kind === 'read' && s.title !== 'Explored').length;
  const folders = steps.filter((s) => s.kind === 'read' && s.title === 'Explored').length;
  const searches = steps.filter((s) => s.kind === 'search').length;
  const checks = steps.filter((s) => s.kind === 'check').length;
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'}`);
  if (folders > 0) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  if (searches > 0) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
  if (checks > 0) parts.push(`${checks} check${checks === 1 ? '' : 's'}`);
  return parts.length ? `Explored ${parts.join(', ')}` : `Explored ${steps.length} step${steps.length === 1 ? '' : 's'}`;
}

/** The collapsed one-liner for a group: what happened, and how much of it. */
function groupLabel(family: Family, steps: AgentStep[]): string {
  if (family === 'explore') return exploreLabel(steps);
  if (family === 'command') return `Ran ${steps.length} command${steps.length === 1 ? '' : 's'}`;
  const files = new Set(steps.map((s) => s.path ?? s.title)).size;
  return `Edited ${files} file${files === 1 ? '' : 's'}`;
}

function noteText(step: AgentStep): string {
  return (step.detail || step.title || '').trim();
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec ? `${min}m ${sec}s` : `${min}m`;
}

const fileName = (p: string) => p.split('/').pop() || p;

const StatusDot: React.FC<{ step: AgentStep; live?: boolean }> = ({ step, live }) => {
  if (live && step.status === 'running') return <span className='step-dot step-dot--running' />;
  if (step.status === 'error') return <span className='step-dot step-dot--error' />;
  return <span className='step-dot' />;
};

const StepRow: React.FC<{ step: AgentStep; live?: boolean }> = ({ step, live }) => {
  const vscode = VSCodeAPI();
  const [outputOpen, setOutputOpen] = useState(false);

  if (step.kind === 'note') {
    return <div className='agent-step-row agent-step-row--note'>{noteText(step)}</div>;
  }

  const openFile = () => {
    if (step.path && step.title !== 'Deleted') {
      vscode.postMessage({ type: MESSAGE_TYPES.OPEN_FILE_IN_EDITOR, path: step.path });
    }
  };

  if (step.kind === 'command') {
    const output = step.meta?.output?.trim();
    // The model labels its own commands ("Run the checkout step tests"); only
    // an unlabelled one (older session, or a model that skipped the field)
    // falls back to showing the raw command inline. Either way the command
    // itself is always in the expanded box, so nothing is hidden.
    const labelled = step.title !== 'Ran' && !!step.detail;
    const expanded = [step.detail ? `$ ${step.detail}` : '', output].filter(Boolean).join('\n\n');
    return (
      <div className={`agent-step-row agent-step-row--command${step.status === 'error' ? ' is-error' : ''}`}>
        <div className='agent-step-line'>
          <StatusDot step={step} live={live} />
          <span className='agent-step-title' title={step.detail}>
            {step.title}
          </span>
          {!labelled && <code className='agent-step-command'>{step.detail}</code>}
          {step.summary && <span className='agent-step-summary'>{step.summary}</span>}
          {expanded && (
            <button
              type='button'
              className='agent-step-output-toggle'
              onClick={() => setOutputOpen((v) => !v)}
            >
              {outputOpen ? 'Hide' : step.status === 'error' ? 'Show error' : 'Show output'}
            </button>
          )}
        </div>
        {expanded && outputOpen && <pre className='agent-step-output'>{expanded}</pre>}
      </div>
    );
  }

  const errorText = step.status === 'error' ? step.meta?.output?.trim() : '';
  return (
    <div className={`agent-step-row${step.status === 'error' ? ' is-error' : ''}`}>
      <div className='agent-step-line'>
        <StatusDot step={step} live={live} />
        <span className='agent-step-title'>{step.title}</span>
        {step.path && (
          <button type='button' className='agent-step-file' title={step.path} onClick={openFile}>
            {fileName(step.path)}
          </button>
        )}
        {step.detail && <span className='agent-step-detail'>{step.detail}</span>}
        {step.summary && <span className='agent-step-summary'>{step.summary}</span>}
        {errorText && (
          <button
            type='button'
            className='agent-step-output-toggle'
            onClick={() => setOutputOpen((v) => !v)}
          >
            {outputOpen ? 'Hide error' : 'Show error'}
          </button>
        )}
      </div>
      {errorText && outputOpen && <pre className='agent-step-output'>{errorText}</pre>}
    </div>
  );
};

/**
 * The work item this run was grounded in — id + title, type/state underneath,
 * clickable straight through to Azure DevOps in the browser.
 */
const TicketChip: React.FC<{ step: AgentStep }> = ({ step }) => {
  const vscode = VSCodeAPI();
  const open = () => {
    if (step.url) vscode.postMessage({ type: MESSAGE_TYPES.OPEN_EXTERNAL, url: step.url });
  };
  return (
    <button type='button' className='agent-ticket-chip' onClick={open} title={`Open ${step.title} in the browser`}>
      <svg className='agent-ticket-chip-icon' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
        <path d='M4 7.5A1.5 1.5 0 0 1 5.5 6h13A1.5 1.5 0 0 1 20 7.5v2a2.5 2.5 0 0 0 0 5v2a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 16.5v-2a2.5 2.5 0 0 0 0-5z' />
      </svg>
      <span className='agent-ticket-chip-text'>
        <span className='agent-ticket-chip-title'>{step.title}</span>
        {step.detail && <span className='agent-ticket-chip-meta'>{step.detail}</span>}
      </span>
      <svg className='agent-ticket-chip-external' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
        <path d='M14 4h6v6' />
        <path d='M20 4l-8 8' />
        <path d='M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4' />
      </svg>
    </button>
  );
};

const AgentTimeline: React.FC<AgentTimelineProps> = ({ steps, live }) => {
  const normalized = steps.map(normalizeAgentStep);
  if (normalized.length === 0) return null;
  // Notices ("your Confluence pick couldn't be honored") are the one step kind
  // the user must not have to go looking for, so they render above the
  // timeline instead of inside it — a lone 'info' step would sit behind two
  // collapsed disclosures ("Worked for 1 step" → "Explored 1 step") and be
  // invisible in exactly the case it matters most, a doc turn with no other
  // steps at all.
  const notices = normalized.filter((s) => s.kind === 'notice');
  // The run's work item, rendered as a chip above the collapsed timeline —
  // the point of it is to be reachable in one click, which a row buried in
  // two disclosures would not be.
  const tickets = normalized.filter((s) => s.kind === 'ticket' && !!s.url);
  const timelineSteps = normalized.filter((s) => s.kind !== 'notice' && s.kind !== 'ticket');
  const items = groupSteps(live ? timelineSteps : compactDoneSteps(timelineSteps));
  const anyRunning = live && timelineSteps.some((s) => s.status === 'running');

  const noticeRows = notices.map((s, i) => (
    <div key={`n${i}`} className='agent-notice'>
      <span className='agent-notice-icon' aria-hidden='true'>!</span>
      <span className='agent-notice-text'>{s.detail ? `${s.title} ${s.detail}` : s.title}</span>
    </div>
  ));

  const ticketRows = tickets.map((s, i) => <TicketChip key={`t${i}`} step={s} />);
  const headerRows = (
    <>
      {noticeRows}
      {ticketRows}
    </>
  );

  // Notice/ticket-only turn (a doc answer that ran no tools at all): there is
  // no timeline to wrap, so don't render an empty "Worked for 0 steps" shell.
  if (timelineSteps.length === 0) {
    return headerRows;
  }

  const body = (
    <div className='agent-timeline-body'>
      {items.map((item, i) => {
        if (item.type === 'note') {
          return (
            <div key={i} className='agent-step-row agent-step-row--note'>
              {noteText(item.step)}
            </div>
          );
        }
        // A lone step needs no disclosure — wrapping one edit in "Edited 1
        // file ▸" just adds a click between the user and the thing itself.
        if (item.steps.length === 1) {
          return <StepRow key={item.steps[0].id ?? `s${i}`} step={item.steps[0]} live={live} />;
        }
        const stats = item.family === 'edit' ? sumEditStats(item.steps) : '';
        return (
          <details key={i} className={`agent-step-group agent-step-group--${item.family}`}>
            <summary>
              <span className='agent-step-group-label'>{groupLabel(item.family, item.steps)}</span>
              {stats && <span className='agent-step-group-stats'>{stats}</span>}
            </summary>
            <div className='agent-step-group-items'>
              {item.steps.map((s, j) => (
                <StepRow key={s.id ?? `g${i}-${j}`} step={s} live={live} />
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );

  if (live) {
    return (
      <>
        {headerRows}
        <div className={`agent-timeline agent-timeline--live${anyRunning ? ' is-running' : ''}`}>{body}</div>
      </>
    );
  }

  return (
    <>
      {headerRows}
      <details className='agent-timeline'>
        <summary>{timelineSteps.length} step{timelineSteps.length === 1 ? '' : 's'}</summary>
        {body}
      </details>
    </>
  );
};

export default AgentTimeline;
