import React from 'react';
import { useSettingsStore } from '../../store/settingsStore';
import { useWorkBriefConfig, useWorkBriefShell } from '../../hooks/useWorkBriefShell';
import SectionShell from './SectionShell';
import StatusDot from './StatusDot';

/**
 * Settings → Ask about my work (beta, desktop only). docs/design/work-brief.md.
 * A floating icon, and a hotkey from any app, open a short conversation that
 * answers from the user's own last year of work (tickets, pages, pull
 * requests, calls), built and kept on this machine.
 */
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);

/** Shortcuts that don't clash with common system ones; values are Tauri accelerators. */
const HOTKEYS: { value: string; mac: string; other: string; macOnly?: boolean }[] = [
  { value: 'CommandOrControl+Shift+Space', mac: '⌘ ⇧ Space', other: 'Ctrl + Shift + Space' },
  // On Windows Alt+Space opens every window's system menu; taking it would break that.
  { value: 'Alt+Space', mac: '⌥ Space', other: 'Alt + Space', macOnly: true },
  { value: 'CommandOrControl+Alt+Space', mac: '⌘ ⌥ Space', other: 'Ctrl + Alt + Space' },
  { value: 'CommandOrControl+Shift+K', mac: '⌘ ⇧ K', other: 'Ctrl + Shift + K' },
  { value: '', mac: 'Off', other: 'Off' },
];
const label = (value: string) => {
  const h = HOTKEYS.find((k) => k.value === value);
  return h ? (isMac ? h.mac : h.other) : value;
};

const WorkBriefSettings: React.FC = () => {
  const updateConfig = useSettingsStore((s) => s.updateConfig);
  const { showIcon, hideInShares, hotkey } = useWorkBriefConfig();
  const status = useWorkBriefShell({ send: false });
  const hotkeyFailed = !!hotkey && status?.hotkey === hotkey && !status.registered;

  const summary = hotkeyFailed ? (
    <>
      <StatusDot tone='warn' />
      Hotkey unavailable
    </>
  ) : (
    <>
      <StatusDot tone='ok' />
      {[showIcon ? 'Icon on' : 'Icon off', hotkey ? label(hotkey) : 'No hotkey'].join(' · ')}
    </>
  );

  return (
    <SectionShell storageKey='work-brief' title='Ask about my work' summary={summary} badge={<span className='beta-badge'>Beta</span>} defaultOpen>
      <div className='settings-form'>
        <small className='form-text'>
          Answers questions about your last year of work (tickets, pages, pull requests and calls) in a few seconds, without searching. Built and kept on this
          machine; only the question and what it needs go to your selected chat model.
        </small>
        <ToggleRow
          label='Show the icon'
          hint='A small icon in the top-right corner of your screen. Click it to ask; drag it to move.'
          checked={showIcon}
          onChange={(on) => updateConfig('workBrief', 'showIcon', on)}
        />
        <ToggleRow
          label='Hide in screen shares'
          hint='People you share your screen with never see it. Turn off to take screenshots of it.'
          checked={hideInShares}
          onChange={(on) => updateConfig('workBrief', 'hideInShares', on)}
        />
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span>Hotkey</span>
            <small className='form-text'>Opens or closes the panel from any app.</small>
          </span>
          <select className='settings-select' value={hotkey} aria-label='Hotkey' onChange={(e) => updateConfig('workBrief', 'hotkey', e.target.value)}>
            {HOTKEYS.filter((k) => isMac || !k.macOnly).map((k) => (
              <option key={k.value || 'off'} value={k.value}>
                {isMac ? k.mac : k.other}
              </option>
            ))}
          </select>
        </label>
        {hotkeyFailed && (
          <small className='form-text'>
            <StatusDot tone='warn' />
            {label(hotkey)} is taken by another app. Pick a different one.
          </small>
        )}
      </div>
    </SectionShell>
  );
};

/** A switch with its label and a one-line hint under it. */
const ToggleRow: React.FC<{ label: string; hint: string; checked: boolean; onChange: (on: boolean) => void }> = ({ label, hint, checked, onChange }) => (
  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span>{label}</span>
      <small className='form-text'>{hint}</small>
    </span>
    <span className='toggle-switch'>
      <input type='checkbox' role='switch' checked={checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className='slider round' />
    </span>
  </label>
);

export default WorkBriefSettings;
