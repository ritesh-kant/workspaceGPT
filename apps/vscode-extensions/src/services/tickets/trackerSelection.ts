/** Enabling a tracker switches off the other without deleting its credentials. */
export function selectTracker<T extends { ado?: any; jira?: any }>(config: T, selected?: 'ado' | 'jira'): T {
  if (selected === 'jira' && config.jira?.isJiraEnabled) return { ...config, ado: { ...config.ado, isAdoEnabled: false } };
  if (config.ado?.isAdoEnabled) return { ...config, jira: { ...config.jira, isJiraEnabled: false } };
  return config;
}
