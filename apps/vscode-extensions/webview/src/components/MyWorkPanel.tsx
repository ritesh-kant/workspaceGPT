import React, { useState } from 'react';

export interface WorkItemSummary {
  id: number;
  title: string;
  type: string;
  state: string;
  sprint?: string;
  url: string;
  changedDate?: string;
  inCurrentSprint: boolean;
}

interface MyWorkPanelProps {
  items: WorkItemSummary[];
  currentSprintName?: string;
  /** True until the first response (cached or fresh) arrives. */
  isLoading: boolean;
  /** Set when the last refresh failed; items may still be a usable cache. */
  error?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
  onSelect: (item: WorkItemSummary) => void;
  /**
   * Click-to-run: start an autonomous agent run on this ticket immediately —
   * no composer stop, no per-change approvals. Optional so the panel renders
   * unchanged for hosts that don't support autonomous runs.
   */
  onAutoRun?: (item: WorkItemSummary) => void;
}

/**
 * How many tickets show before the list is collapsed behind "+N more". Three
 * keeps the greeting, this panel, and recent chats all visible without
 * scrolling in a typical sidebar; the expander is one click away.
 */
const VISIBLE_LIMIT = 3;

/**
 * The sprint's own name out of an ADO iteration path.
 *
 * Paths are project-rooted and can nest (`D2C\\Release 1\\Sprint 24`), so the
 * leaf is the sprint the item is actually in. A single-segment path is the
 * project root — the item is in no sprint at all — and returns undefined
 * rather than labelling the row with the project name.
 */
export function sprintLabel(iterationPath?: string): string | undefined {
  const segments = String(iterationPath ?? '')
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 1 ? segments[segments.length - 1] : undefined;
}

const RefreshIcon: React.FC<{ spinning?: boolean }> = ({ spinning }) => (
  <svg
    className={spinning ? 'my-work-refresh-icon my-work-refresh-icon--spinning' : 'my-work-refresh-icon'}
    width='14'
    height='14'
    viewBox='0 0 24 24'
    fill='none'
    xmlns='http://www.w3.org/2000/svg'
    aria-hidden='true'
  >
    <path d='M21 12a9 9 0 1 1-2.64-6.36' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
    <path d='M21 3v6h-6' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
  </svg>
);

/**
 * "Your work" — the tickets assigned to you, shown in the chat empty state.
 *
 * This is the product's opening frame and the whole positioning in one panel:
 * every other coding agent opens on an empty box over your repo, because the
 * repo is all it knows. Clicking a ticket seeds the composer but deliberately
 * does NOT send — the user stays in control of the first move. The row carries
 * a resting chevron and a hover "Start" label so that click is discoverable.
 */
const MyWorkPanel: React.FC<MyWorkPanelProps> = ({
  items,
  currentSprintName,
  isLoading,
  error,
  isRefreshing,
  onRefresh,
  onSelect,
  onAutoRun,
}) => {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, VISIBLE_LIMIT);
  const hiddenCount = items.length - VISIBLE_LIMIT;

  return (
    <div className='my-work-panel'>
      <div className='my-work-header'>
        <h2 className='my-work-title'>
          Your work
          {currentSprintName && (
            <span className='my-work-title-sprint'> · {currentSprintName}</span>
          )}
        </h2>
        <button
          type='button'
          className='my-work-refresh'
          onClick={onRefresh}
          disabled={isRefreshing}
          data-tooltip='Refresh'
          aria-label='Refresh your work items'
        >
          <RefreshIcon spinning={isRefreshing} />
        </button>
      </div>

      {/* An error with a usable cache is a staleness note, not a failure — the
          list below is still real work the user can act on. */}
      {error && (
        <div className={`my-work-note ${items.length ? 'my-work-note--warn' : 'my-work-note--error'}`}>
          {items.length ? `Showing your last synced tickets — refresh failed: ${error}` : error}
        </div>
      )}

      {isLoading && !items.length ? (
        <div className='my-work-empty'>Loading your tickets…</div>
      ) : !items.length && !error ? (
        <div className='my-work-empty'>Nothing assigned to you right now.</div>
      ) : (
        <div className={`my-work-list${expanded ? ' my-work-list--expanded' : ''}`}>
          {visible.map((item) => {
            const itemSprint = sprintLabel(item.sprint);
            // The header already names the current sprint; only a ticket that
            // sits elsewhere needs its sprint spelled out on the row.
            const showSprint = itemSprint && itemSprint !== currentSprintName;
            return (
              <button
                key={item.id}
                type='button'
                className='my-work-item'
                onClick={() => onSelect(item)}
                title={item.title}
              >
                {/* Defensive: these items can come from a cache written by an
                    older build, and one missing field must not take down the
                    whole empty state. */}
                <span
                  className={`my-work-state-dot state-${(item.state ?? '').toLowerCase().replace(/\s+/g, '-')}`}
                />
                <span className='my-work-item-body'>
                  <span className='my-work-item-title'>
                    <span className='my-work-item-id'>#{item.id}</span> {item.title}
                  </span>
                  <span className='my-work-item-meta'>
                    {[item.type, item.state, showSprint ? itemSprint : undefined].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className='my-work-item-actions'>
                  {onAutoRun && (
                    <span
                      className='my-work-item-run'
                      role='button'
                      tabIndex={0}
                      data-tooltip='Run autonomously'
                      aria-label={`Run ticket ${item.id} autonomously`}
                      onClick={(e) => {
                        // The row itself seeds the composer; this must not.
                        e.stopPropagation();
                        onAutoRun(item);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          onAutoRun(item);
                        }
                      }}
                    >
                      <svg width='11' height='11' viewBox='0 0 24 24' fill='currentColor' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
                        <path d='M7 4.5v15l12-7.5L7 4.5z' />
                      </svg>
                    </span>
                  )}
                  <span className='my-work-item-start'>
                    <span className='my-work-item-start-label'>Start</span>
                    <svg width='12' height='12' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg' aria-hidden='true'>
                      <path d='M9 6l6 6-6 6' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
                    </svg>
                  </span>
                </span>
              </button>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type='button'
              className='my-work-more-button'
              onClick={() => setExpanded((wasExpanded) => !wasExpanded)}
              aria-expanded={expanded}
            >
              {expanded ? 'Show fewer' : `+${hiddenCount} more assigned to you`}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default MyWorkPanel;
