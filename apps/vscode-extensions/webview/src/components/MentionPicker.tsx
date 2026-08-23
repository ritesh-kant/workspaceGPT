import React, { useEffect, useRef } from 'react';
import type { MentionTarget } from '../constants';

interface MentionPickerProps {
  targets: MentionTarget[];
  activeIndex: number;
  /** What the user has typed after "@" — echoed in the empty state. */
  query: string;
  isSearching: boolean;
  onSelect: (target: MentionTarget) => void;
  onHoverIndex: (index: number) => void;
}

const FileIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

const FolderIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

/**
 * The "@" autocomplete over workspace files and folders. Purely presentational
 * — keyboard navigation lives in the composer (App.tsx), because the arrow and
 * Enter keys have to be intercepted on the textarea itself before they insert
 * a newline or send the message.
 */
const MentionPicker: React.FC<MentionPickerProps> = ({
  targets,
  activeIndex,
  query,
  isSearching,
  onSelect,
  onHoverIndex,
}) => {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the keyboard-selected row visible when the list scrolls.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="mention-picker" role="listbox" aria-label="Mention a file or folder">
      {targets.length === 0 ? (
        <div className="mention-picker-empty">
          {isSearching ? 'Searching…' : query ? `No files matching "${query}"` : 'No files found'}
        </div>
      ) : (
        targets.map((target, i) => (
          <button
            key={target.path}
            ref={i === activeIndex ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            className={`mention-picker-item${i === activeIndex ? ' mention-picker-item--active' : ''}`}
            // Keep focus in the textarea: mousedown would blur it first, and a
            // blur-driven dismiss would unmount this row before the click lands.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(target);
            }}
            onMouseEnter={() => onHoverIndex(i)}
          >
            <span className="mention-picker-icon">
              {target.kind === 'folder' ? <FolderIcon /> : <FileIcon />}
            </span>
            <span className="mention-picker-name">{target.name}</span>
            <span className="mention-picker-path">{target.path}</span>
          </button>
        ))
      )}
    </div>
  );
};

export default MentionPicker;
