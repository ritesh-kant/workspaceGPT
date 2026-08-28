import React, { useState } from 'react';
import { VSCodeAPI } from '../vscode';
import { MESSAGE_TYPES } from '../constants';
import { AgentStep, normalizeAgentStep } from '../store/chatStore';

/**
 * Compact agent timeline, matching how Cursor / Claude Code present a turn:
 * exploration is one collapsed "Explored N …" disclosure, model reasoning is
 * a collapsed "Thought for Xs" disclosure (the prose is inside, not inline),
 * and command stdout stays behind "Show output". Mutations (edits, commands)
 * stay as one-line rows so the user can still see what changed.
 *
 * Live and done use the same collapsed defaults — expanding mid-run is how
 * the noise in the transcript used to happen. The loading indicator already
 * names the in-flight tool.
 */

interface AgentTimelineProps {
  steps: (AgentStep | string)[];
  /** Milliseconds the turn took — renders the "Worked for Xs" header (done mode). */
  durationMs?: number;
  /** Live mode: pulse the currently running step (once the user expands its group). */
  live?: boolean;
}

type TimelineItem =
  | { type: 'group'; steps: AgentStep[] }
  | { type: 'thought'; steps: AgentStep[]; title: string }
  | { type: 'step'; step: AgentStep };

const GROUPABLE = new Set(['search', 'read', 'check', 'info']);
const THOUGHTISH = new Set(['thought', 'note']);

function groupSteps(steps: AgentStep[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const step of steps) {
    if (THOUGHTISH.has(step.kind)) {
      const last = items[items.length - 1];
      if (last && last.type === 'thought') {
        last.steps.push(step);
        if (step.kind === 'thought' && step.title) last.title = step.title;
      } else {
        items.push({
          type: 'thought',
          steps: [step],
          title: step.kind === 'thought' && step.title ? step.title : 'Thought',
        });
      }
    } else if (GROUPABLE.has(step.kind)) {
      const last = items[items.length - 1];
      if (last && last.type === 'group') {
        last.steps.push(step);
      } else {
        items.push({ type: 'group', steps: [step] });
      }
    } else {
      items.push({ type: 'step', step });
    }
  }
  return items;
}

function groupLabel(steps: AgentStep[]): string {
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

  if (step.kind === 'thought') {
    return <div className='agent-step-row agent-step-row--thought'>{step.title}</div>;
  }
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
    return (
      <div className={`agent-step-row agent-step-row--command${step.status === 'error' ? ' is-error' : ''}`}>
        <div className='agent-step-line'>
          <StatusDot step={step} live={live} />
          <span className='agent-step-title'>{step.title}</span>
          <code className='agent-step-command'>{step.detail}</code>
          {step.summary && <span className='agent-step-summary'>{step.summary}</span>}
          {output && (
            <button
              type='button'
              className='agent-step-output-toggle'
              onClick={() => setOutputOpen((v) => !v)}
            >
              {outputOpen ? 'Hide output' : 'Show output'}
            </button>
          )}
        </div>
        {output && outputOpen && <pre className='agent-step-output'>{output}</pre>}
      </div>
    );
  }

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
      </div>
    </div>
  );
};

/** Collapsed-by-default reasoning block. Empty thought rows (just a duration) stay a one-liner. */
const ThoughtGroup: React.FC<{ title: string; steps: AgentStep[] }> = ({ title, steps }) => {
  const notes = steps.filter((s) => s.kind === 'note' && noteText(s));
  if (notes.length === 0) {
    return <div className='agent-step-row agent-step-row--thought'>{title}</div>;
  }
  return (
    <details className='agent-step-group agent-step-group--thought'>
      <summary>
        <span className='agent-step-group-label'>{title}</span>
      </summary>
      <div className='agent-step-group-items'>
        {notes.map((s, i) => (
          <div key={s.id ?? `n${i}`} className='agent-step-row agent-step-row--note'>
            {noteText(s)}
          </div>
        ))}
      </div>
    </details>
  );
};

const AgentTimeline: React.FC<AgentTimelineProps> = ({ steps, durationMs, live }) => {
  const normalized = steps.map(normalizeAgentStep);
  if (normalized.length === 0) return null;
  // Notices ("your Confluence pick couldn't be honored") are the one step kind
  // the user must not have to go looking for, so they render above the
  // timeline instead of inside it — a lone 'info' step would sit behind two
  // collapsed disclosures ("Worked for 1 step" → "Explored 1 step") and be
  // invisible in exactly the case it matters most, a doc turn with no other
  // steps at all.
  const notices = normalized.filter((s) => s.kind === 'notice');
  const timelineSteps = normalized.filter((s) => s.kind !== 'notice');
  const items = groupSteps(timelineSteps);
  const anyRunning = live && timelineSteps.some((s) => s.status === 'running');

  const noticeRows = notices.map((s, i) => (
    <div key={`n${i}`} className='agent-notice'>
      <span className='agent-notice-icon' aria-hidden='true'>!</span>
      <span className='agent-notice-text'>{s.detail ? `${s.title} ${s.detail}` : s.title}</span>
    </div>
  ));

  // Notice-only turn (a doc/ticket answer that ran no tools at all): there is
  // no timeline to wrap, so don't render an empty "Worked for 0 steps" shell.
  if (timelineSteps.length === 0) {
    return <>{noticeRows}</>;
  }

  const body = (
    <div className='agent-timeline-body'>
      {items.map((item, i) =>
        item.type === 'group' ? (
          <details key={i} className='agent-step-group'>
            <summary>
              <span className='agent-step-group-label'>{groupLabel(item.steps)}</span>
            </summary>
            <div className='agent-step-group-items'>
              {item.steps.map((s, j) => (
                <StepRow key={s.id ?? `g${i}-${j}`} step={s} live={live} />
              ))}
            </div>
          </details>
        ) : item.type === 'thought' ? (
          <ThoughtGroup key={i} title={item.title} steps={item.steps} />
        ) : (
          <StepRow key={item.step.id ?? `s${i}`} step={item.step} live={live} />
        )
      )}
    </div>
  );

  if (live) {
    return (
      <>
        {noticeRows}
        <div className={`agent-timeline agent-timeline--live${anyRunning ? ' is-running' : ''}`}>{body}</div>
      </>
    );
  }

  return (
    <>
      {noticeRows}
      <details className='agent-timeline'>
        <summary>
          Worked for {durationMs ? formatDuration(durationMs) : `${timelineSteps.length} step${timelineSteps.length === 1 ? '' : 's'}`}
        </summary>
        {body}
      </details>
    </>
  );
};

export default AgentTimeline;
