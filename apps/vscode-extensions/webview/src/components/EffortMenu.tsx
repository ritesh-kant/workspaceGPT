import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { effortLabel } from '../store/modelStore';

interface Props {
  value: string;
  levels: string[];
  onChange: (value: string) => void;
}

/** A nested effort menu, kept within the model popup's DOM for outside-click handling. */
const EffortMenu: React.FC<Props> = ({ value, levels, onChange }) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  // Opened by hover: closes when the pointer leaves the row and the flyout.
  // Opened by click or keyboard: stays until a choice, Escape or outside click.
  const openedByHover = useRef(false);
  const leaveTimer = useRef<number>();
  const options = ['', ...levels];

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const rect = trigger.getBoundingClientRect();
      const parent = trigger.closest('.searchable-dropdown-menu')?.getBoundingClientRect() ?? rect;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const gutter = 8;
      // Prefer a flyout beside the model list; stack above it in narrow panels.
      const rightFits = parent.right + width + gutter <= window.innerWidth;
      const leftFits = parent.left - width - gutter >= 0;
      const left = rightFits ? parent.right : leftFits ? parent.left - width : parent.right - width;
      const top = rightFits || leftFits ? rect.bottom - height : parent.top - height;
      setPosition({
        left: Math.max(gutter, Math.min(left, window.innerWidth - width - gutter)),
        top: Math.max(gutter, Math.min(top, window.innerHeight - height - gutter)),
      });
    };
    place();
    if (focusOnOpen.current) {
      menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
      focusOnOpen.current = false;
    }
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, value, levels]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      className='model-effort-menu'
      // The flyout is a DOM child, so moving between row and flyout is not a leave;
      // the grace period covers the few pixels of popup edge between them.
      onMouseEnter={() => window.clearTimeout(leaveTimer.current)}
      onMouseLeave={() => {
        if (!openedByHover.current) return;
        leaveTimer.current = window.setTimeout(() => setOpen(false), 250);
      }}
    >
      <button
        ref={triggerRef}
        type='button'
        className='model-effort-trigger'
        aria-haspopup='menu'
        aria-expanded={open}
        onMouseEnter={() => {
          if (open) return;
          openedByHover.current = true;
          setOpen(true);
        }}
        onClick={() => {
          openedByHover.current = false;
          if (open) menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
          else { focusOnOpen.current = true; setOpen(true); }
        }}
        onKeyDown={(event) => {
          if (['ArrowRight', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            openedByHover.current = false;
            if (open) menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
            else { focusOnOpen.current = true; setOpen(true); }
          }
        }}
      >
        <span>Effort</span>
        <span className='model-effort-value'>{value ? effortLabel(value) : 'Default'}</span>
        <span aria-hidden='true'>›</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          className='model-effort-submenu'
          role='menu'
          aria-label='Reasoning effort'
          style={position}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'ArrowLeft') {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }
          }}
        >
          <p>Higher effort gives the model more time to reason, but takes longer and uses more tokens.</p>
          {options.map((level) => (
            <button
              key={level}
              type='button'
              role='menuitemradio'
              aria-checked={value === level}
              onClick={() => { onChange(level); close(); }}
            >
              <span>{level ? effortLabel(level) : 'Default'}</span>
              {value === level && <span className='model-effort-check' aria-hidden='true'>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default EffortMenu;
