import React from 'react';
import type { SlashCommand } from '../utils/slashCommands';

interface Props {
  commands: SlashCommand[];
  /** What was typed after "/", so the matching start of each name can be set in bold. */
  query: string;
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHoverIndex: (index: number) => void;
}

/** The "/" command list. Presentational: the composer owns the keys, like the @ picker. */
const SlashCommandPicker: React.FC<Props> = ({ commands, query, activeIndex, onSelect, onHoverIndex }) => (
  <div className='mention-picker slash-picker' role='listbox' aria-label='Commands'>
    {commands.map((c, i) => (
      <button
        key={c.name}
        type='button'
        role='option'
        aria-selected={i === activeIndex}
        className={`mention-picker-item${i === activeIndex ? ' mention-picker-item--active' : ''}`}
        // Keep focus in the textarea, as the @ picker does.
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect(c);
        }}
        onMouseEnter={() => onHoverIndex(i)}
      >
        <span className='slash-picker-name'>
          <strong>{c.name.slice(0, query.length)}</strong>
          {c.name.slice(query.length)}
        </span>
        <span className='slash-picker-desc'>{c.description}</span>
      </button>
    ))}
  </div>
);

export default SlashCommandPicker;
