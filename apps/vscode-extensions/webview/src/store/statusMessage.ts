import { useSettingsStore } from './settingsStore';

export type StatusSection = 'confluence' | 'codebase' | 'ado' | 'deployment';

/** At most one pending auto-clear per section. */
const pending: Partial<Record<StatusSection, ReturnType<typeof setTimeout>>> = {};

/**
 * Hide a transient status message after a delay — but only if it is still the
 * message on screen.
 *
 * The naive version (clear the field unconditionally after 2s) drops messages
 * that matter: "Starting sync…" schedules a clear, a sync error replaces it
 * 1.5s later, and the original timer then wipes the error before the user has
 * read it. Capturing the message this timer was scheduled for makes the clear
 * a no-op once something newer has taken its place.
 */
export function clearStatusMessageAfterDelay(
  section: StatusSection,
  delay: number = 2000
): void {
  const scheduledFor = useSettingsStore.getState().config[section]?.statusMessage;

  const existing = pending[section];
  if (existing) clearTimeout(existing);

  pending[section] = setTimeout(() => {
    delete pending[section];
    const current = useSettingsStore.getState().config[section]?.statusMessage;
    if (current !== scheduledFor) return;
    useSettingsStore.getState().batchUpdateConfig(section, { statusMessage: undefined });
  }, delay);
}
