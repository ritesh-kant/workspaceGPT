import React, { useContext, useEffect, useRef, useState } from 'react';

/**
 * How Settings lays its sections out.
 *
 * - `stack`: every section is a collapsible card in one scrolling column (the
 *   VS Code sidebar).
 * - `page`: the desktop app. A nav column on the left picks a page; a page
 *   shows one or more sections as always-open cards under its own heading
 *   and description (Settings.tsx). `pageTitle` is that heading: a section
 *   with the same title is the page's only subject, so its card repeats
 *   neither the name nor the description and keeps just its status row.
 */
export type SettingsLayout = 'stack' | 'page';
export interface SettingsLayoutValue {
  layout: SettingsLayout;
  pageTitle?: string;
}
export const SettingsLayoutContext = React.createContext<SettingsLayoutValue>({ layout: 'stack' });

interface SectionShellProps {
  /** Stable key for remembering this section's open state across sessions. */
  storageKey: string;
  title: string;
  /**
   * One-line state summary shown on the header while collapsed — "✅ Connected ·
   * SPACE · synced 2h ago". This is what makes collapsing safe: the answer to
   * "is this configured and healthy?" never requires expanding.
   */
  summary?: React.ReactNode;
  /** Rendered on the header, right of the summary (e.g. the enable toggle). */
  headerControl?: React.ReactNode;
  badge?: React.ReactNode;
  /** Open state on the very first visit, before the user has toggled anything. */
  defaultOpen?: boolean;
  /**
   * The section needs the user's attention (disconnected, error, mid-sync).
   * Opens the section when it becomes true — including while collapsed — but a
   * manual collapse afterwards still wins, so an unfixable error can't pin a
   * section open.
   */
  needsAttention?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const storagePrefix = 'workspacegpt.settingsSection.';

function readStored(storageKey: string): boolean | null {
  try {
    const stored = localStorage.getItem(storagePrefix + storageKey);
    return stored === null ? null : stored === 'true';
  } catch {
    return null;
  }
}

function writeStored(storageKey: string, open: boolean): void {
  try {
    localStorage.setItem(storagePrefix + storageKey, String(open));
  } catch {
    // Non-persistent storage: the toggle still works for this session.
  }
}

/**
 * A Settings card that collapses to a single status line.
 *
 * Every section used to render at full height whether or not it needed
 * anything, so a fully configured panel was several screens of scrolling to
 * reach the section you actually came for. Healthy sections now collapse; the
 * ones mid-setup or erroring open themselves.
 */
const SectionShell: React.FC<SectionShellProps> = ({
  storageKey,
  title,
  summary,
  headerControl,
  badge,
  defaultOpen = false,
  needsAttention = false,
  className,
  children,
}) => {
  const [open, setOpen] = useState<boolean>(() => {
    const stored = readStored(storageKey);
    return stored === null ? defaultOpen || needsAttention : stored;
  });

  // Open on the *transition* into needing attention, not on every render while
  // it does — otherwise the user could never collapse a section with a
  // persistent error.
  const wasNeedingAttention = useRef(needsAttention);
  useEffect(() => {
    if (needsAttention && !wasNeedingAttention.current) {
      setOpen(true);
    }
    wasNeedingAttention.current = needsAttention;
  }, [needsAttention]);

  const toggle = () => {
    setOpen((wasOpen) => {
      writeStored(storageKey, !wasOpen);
      return !wasOpen;
    });
  };

  const { layout, pageTitle } = useContext(SettingsLayoutContext);
  if (layout === 'page') {
    // The page heading already names a section titled like the page; its
    // card then opens with the status row alone (or straight into the body).
    const isPageSubject = pageTitle === title;
    const hasHeader = !isPageSubject || summary || headerControl;
    return (
      <div className={`settings-section settings-section--page${className ? ` ${className}` : ''}`}>
        {hasHeader && (
          <div className={`section-header section-header--page${isPageSubject ? ' section-header--status' : ''}`}>
            {isPageSubject ? (
              <span className='section-status'>{summary}</span>
            ) : (
              <div className='section-page-heading'>
                <h3>
                  {title}
                  {badge}
                </h3>
                {summary && <span className='section-summary section-summary--page'>{summary}</span>}
              </div>
            )}
            {headerControl}
          </div>
        )}
        {children}
        {/* A switched-off source renders no body; say what the toggle does
            rather than leave a status row alone in a card. */}
        {!children && headerControl && (
          <p className='section-empty'>Turn on {title} to connect an account and choose what to sync.</p>
        )}
      </div>
    );
  }

  return (
    <div className={`settings-section${className ? ` ${className}` : ''}`}>
      <div className='section-header section-header--collapsible'>
        <button
          type='button'
          className='section-toggle'
          onClick={toggle}
          aria-expanded={open}
          aria-label={title}
        >
          <span className={`section-chevron${open ? ' section-chevron--open' : ''}`}>▶</span>
          <h3>
            {title}
            {badge}
          </h3>
          {!open && summary && <span className='section-summary'>{summary}</span>}
        </button>
        {/* Outside the toggle button: nested interactive controls would be
            invalid markup and would fire the collapse on every click. */}
        {headerControl}
      </div>
      {open && children}
    </div>
  );
};

export default SectionShell;
