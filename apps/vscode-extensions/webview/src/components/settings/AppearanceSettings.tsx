import React, { useState } from 'react';
import SectionShell from './SectionShell';

type Appearance = 'system' | 'light' | 'dark';
const KEY = 'workspacegpt.appearance';

function savedAppearance(): Appearance {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark') return value;
  } catch {
    // Keep the system default when storage is unavailable.
  }
  return 'system';
}

const AppearanceSettings: React.FC = () => {
  const [appearance, setAppearance] = useState<Appearance>(savedAppearance);

  function change(value: Appearance) {
    setAppearance(value);
    try {
      if (value === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, value);
    } catch {
      // The selection still applies in this view for this visit.
      if (value === 'system') delete document.documentElement.dataset.wgptTheme;
      else document.documentElement.dataset.wgptTheme = value;
      return;
    }
    // Storage events notify the other frames; this frame receives no storage
    // event for its own write, so ask its preloaded appearance script to apply.
    window.dispatchEvent(new Event('wgpt-appearance-change'));
  }

  return (
    <SectionShell storageKey='appearance' title='Appearance' defaultOpen>
      <div className='settings-form'>
        <div className='form-group'>
          <label htmlFor='appearance-select'>Theme</label>
          <select
            id='appearance-select'
            className='settings-select'
            value={appearance}
            onChange={(event) => change(event.target.value as Appearance)}
          >
            <option value='system'>System</option>
            <option value='light'>Light</option>
            <option value='dark'>Dark</option>
          </select>
        </div>
      </div>
    </SectionShell>
  );
};

export default AppearanceSettings;
