import React, { useEffect, useRef, useState } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  /** Optional second line shown under the label (e.g. a key or type). */
  subtitle?: string;
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

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery, isOpen]);

  // No search box to auto-focus (≤6 options) — focus the menu itself so arrow
  // keys work immediately after opening via keyboard.
  useEffect(() => {
    if (isOpen && !showSearch) {
      menuRef.current?.focus();
    }
  }, [isOpen, showSearch]);

  const choose = (v: string) => {
    onChange(v);
    setIsOpen(false);
    setSearchQuery('');
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
      setHighlightedIndex((i) => Math.min(i + 1, navOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = navOptions[highlightedIndex];
      if (opt) choose(opt.value);
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
                  onClick={() => choose(o.value)}
                  className={`searchable-dropdown-item${o.value === value ? ' selected' : ''}${
                    highlightedIndex === navIndex ? ' highlighted' : ''
                  }`}
                  role="option"
                  aria-selected={o.value === value}
                >
                  <div className="item-title">{o.label}</div>
                  {o.subtitle && <div className="item-subtitle">{o.subtitle}</div>}
                </li>
              );
            })}
            {filtered.length === 0 && <li className="searchable-dropdown-empty">{emptyLabel}</li>}
          </ul>
        </div>
      )}
    </div>
  );
};

export default SearchableDropdown;
