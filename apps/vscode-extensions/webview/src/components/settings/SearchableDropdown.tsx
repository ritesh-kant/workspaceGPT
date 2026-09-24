import React, { useEffect, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  /** Optional second line shown under the label (e.g. a key or type). */
  subtitle?: string;
  /**
   * Offer the row but refuse the pick — for a choice that exists in principle
   * but can't be used right now. Pair it with a `subtitle` saying why, or the
   * row reads as broken.
   */
  disabled?: boolean;
  /** 0–100. When set, a thin bar is drawn under the subtitle. */
  progress?: number;
  /**
   * What a click on a disabled row does instead of picking it — e.g. open the
   * Settings page where the reason in the subtitle can be fixed. The row stays
   * unpickable but becomes clickable and keyboard-reachable.
   */
  disabledAction?: () => void;
}

interface SearchableDropdownProps {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  /** Shown in the trigger when nothing is selected. */
  placeholder?: string;
  /**
   * Force the trigger text regardless of the selected value. Useful for
   * "action" menus (e.g. a preset loader) where picking an item runs a command
   * rather than setting a persistent value.
   */
  triggerLabel?: string;
  /** Show a search box. Defaults to true when there are more than 6 options. */
  searchable?: boolean;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** Render a "clear selection" row at the top of the menu. */
  clearable?: boolean;
  clearLabel?: string;
  emptyLabel?: string;
  /** A quiet row under the list that runs a command rather than picking a value. */
  footer?: { label: string; onClick: () => void };
}

/**
 * Searchable dropdown matching the Confluence space picker — a themed trigger
 * plus an absolutely-positioned menu with optional live search. Replaces the
 * unstyled native <select>, and respects the VS Code theme via the shared
 * `.searchable-dropdown-*` classes in Settings.css.
 */
const SearchableDropdown: React.FC<SearchableDropdownProps> = ({
  value,
  options,
  onChange,
  placeholder = '-- Select --',
  triggerLabel,
  searchable,
  searchPlaceholder = 'Search...',
  disabled = false,
  clearable = false,
  clearLabel = '-- Clear selection --',
  emptyLabel = 'No matches found...',
  footer,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const showSearch = searchable ?? options.length > 6;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selected = options.find((o) => o.value === value);
  const filtered = showSearch
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (o.subtitle?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false),
      )
    : options;
  // The clear row (if any) counts as a navigable entry at index 0.
  const navOptions: DropdownOption[] = clearable
    ? [{ value: '', label: clearLabel }, ...filtered]
    : filtered;
  // A disabled row with nothing to do on click is skipped by the keyboard.
  const inert = (o: DropdownOption) => !!o.disabled && !o.disabledAction;
  // Opening onto an inert row would make the first Enter do nothing.
  const firstEnabledIndex = Math.max(0, navOptions.findIndex((o) => !inert(o)));

  useEffect(() => {
    setHighlightedIndex(firstEnabledIndex);
  }, [searchQuery, isOpen, firstEnabledIndex]);

  // No search box to auto-focus (≤6 options) — focus the menu itself so arrow
  // keys work immediately after opening via keyboard.
  useEffect(() => {
    if (isOpen && !showSearch) {
      menuRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen, showSearch]);

  const choose = (v: string) => {
    onChange(v);
    setIsOpen(false);
    setSearchQuery('');
  };

  /**
   * A disabled row is never picked. With a `disabledAction` the click runs
   * that instead and closes the menu; without one it is a no-op and the menu
   * stays open so the reason in its subtitle can be read.
   */
  const chooseOption = (o: DropdownOption) => {
    if (o.disabled) {
      if (o.disabledAction) {
        o.disabledAction();
        setIsOpen(false);
        setSearchQuery('');
      }
      return;
    }
    choose(o.value);
  };

  /** Next reachable index in `direction`, or `from` when every remaining row is inert. */
  const nextEnabled = (from: number, direction: 1 | -1) => {
    for (let i = from + direction; i >= 0 && i < navOptions.length; i += direction) {
      if (!inert(navOptions[i])) return i;
    }
    return from;
  };

  const openMenu = () => {
    if (!disabled) setIsOpen(true);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setIsOpen((open) => !open);
    } else if (e.key === 'ArrowDown' && !isOpen) {
      e.preventDefault();
      openMenu();
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => nextEnabled(i, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => nextEnabled(i, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = navOptions[highlightedIndex];
      if (opt) chooseOption(opt);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setSearchQuery('');
    }
  };

  return (
    <div className="searchable-dropdown-container" ref={dropdownRef}>
      <div
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleTriggerKeyDown}
        className={`searchable-dropdown-trigger${disabled ? ' disabled' : ''}`}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-disabled={disabled}
      >
        <span className="trigger-text">
          {triggerLabel ?? (selected ? selected.label : placeholder)}
        </span>
        <span className="trigger-arrow">{isOpen ? '▲' : '▼'}</span>
      </div>

      {isOpen && !disabled && (
        <div
          className="searchable-dropdown-menu"
          role="listbox"
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
        >
          {showSearch && (
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
              className="searchable-dropdown-input"
              onClick={(e) => e.stopPropagation()}
            />
          )}
          <ul className="searchable-dropdown-list">
            {clearable && (
              <li
                onClick={() => choose('')}
                className={`searchable-dropdown-item clickable${highlightedIndex === 0 ? ' highlighted' : ''}`}
                role="option"
                aria-selected={value === ''}
              >
                <span className="item-subtitle">{clearLabel}</span>
              </li>
            )}
            {filtered.map((o, idx) => {
              const navIndex = idx + (clearable ? 1 : 0);
              return (
                <li
                  key={o.value}
                  onClick={() => chooseOption(o)}
                  className={`searchable-dropdown-item${o.value === value ? ' selected' : ''}${
                    highlightedIndex === navIndex ? ' highlighted' : ''
                  }${o.disabled ? ' disabled' : ''}${o.disabled && o.disabledAction ? ' actionable' : ''}${
                    typeof o.progress === 'number' ? ' has-progress' : ''
                  }`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled}
                >
                  <div className="item-title">{o.label}</div>
                  {o.subtitle && <div className="item-subtitle">{o.subtitle}</div>}
                  {typeof o.progress === 'number' && (
                    <div
                      className="item-progress"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={o.progress}
                      aria-label={o.subtitle || `${o.label} progress`}
                    >
                      <div
                        className="item-progress-fill"
                        style={{ width: `${Math.max(0, Math.min(100, o.progress))}%` }}
                      />
                    </div>
                  )}
                </li>
              );
            })}
            {filtered.length === 0 && <li className="searchable-dropdown-empty">{emptyLabel}</li>}
          </ul>
          {footer && (
            <button
              type="button"
              className="searchable-dropdown-footer"
              onClick={() => {
                footer.onClick();
                setIsOpen(false);
                setSearchQuery('');
              }}
            >
              {footer.label}
              <span aria-hidden="true"> ›</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default SearchableDropdown;
