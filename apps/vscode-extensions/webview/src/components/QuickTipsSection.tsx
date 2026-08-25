import React, { useEffect, useState } from 'react';
import { WorkspaceMode } from '../constants';

interface QuickTipsSectionProps {
  mode: WorkspaceMode;
  onOpenSettings: () => void;
}

const STORAGE_KEY = 'workspacegpt.homeTipsExpanded';

/**
 * Tips are onboarding content: worth a full read once, not worth permanent
 * vertical space on every empty state. Expanded on the very first visit, then
 * collapsed by default — and whatever the user sets afterwards sticks.
 * localStorage can be unavailable in a sandboxed webview, in which case this
 * degrades to "expanded every session", which is just the old behavior.
 */
function initialExpanded(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

const QuickTipsSection: React.FC<QuickTipsSectionProps> = ({ mode, onOpenSettings }) => {
  const [expanded, setExpanded] = useState<boolean>(initialExpanded);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) === null) {
        localStorage.setItem(STORAGE_KEY, 'false');
      }
    } catch {
      // Non-persistent storage: nothing to mark.
    }
  }, []);

  const toggle = () => {
    setExpanded((wasExpanded) => {
      const next = !wasExpanded;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Non-persistent storage: the toggle still works for this session.
      }
      return next;
    });
  };

  return (
    <div className='tips-section'>
      <button
        type='button'
        className='tips-section-toggle'
        onClick={toggle}
        aria-expanded={expanded}
      >
        <span className={`tips-section-chevron${expanded ? ' tips-section-chevron--open' : ''}`}>
          ▶
        </span>
        <span className='tips-section-label'>✨ Quick Tips</span>
        {/* The privacy posture is the one tip worth a glance even when
            collapsed, so it doubles as the collapsed summary. */}
        {!expanded && (
          <span className='tips-section-summary'>
            🛡️ {mode === 'remote' ? 'Remote mode' : 'Local mode — fully offline'}
          </span>
        )}
      </button>

      {expanded && (
        <div className='tips-list'>
          <div className='tip-item'>
            <span className='tip-icon'>🛡️</span>
            <span>
              {mode === 'remote'
                ? "You're in Remote mode: chat models run in the cloud, and your search index lives in your own Qdrant cluster."
                : "You're in Local mode: everything — chat model, embeddings, and your search index — runs on this machine. No account, no telemetry."}
            </span>
          </div>
          <div
            className='tip-item tip-item--interactive'
            onClick={onOpenSettings}
            role='button'
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpenSettings();
            }}
          >
            <span className='tip-icon'>🔗</span>
            <span>
              Connect Confluence in Settings to access your team's knowledge base
              instantly
            </span>
            <span className='tip-arrow'>→</span>
          </div>
          <div className='tip-item'>
            <span className='tip-icon'>🧑‍💻</span>
            <span>
              Ask it to change code, not just explain it — every edit is shown as
              a diff you approve first, and always revertable
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuickTipsSection;
