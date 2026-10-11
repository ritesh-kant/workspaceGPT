import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'WorkspaceGPT',
  version: '0.4.0',
  description:
    'Ask your Confluence, Jira and Azure DevOps Knowledge from a side panel. Answers come from WorkspaceGPT Desktop.',
  icons: {
    '16': 'icon.png',
    '32': 'icon.png',
    '48': 'icon.png',
    '128': 'icon.png',
  },
  action: {
    default_title: 'WorkspaceGPT',
    default_icon: {
      '16': 'icon.png',
      '32': 'icon.png',
      '48': 'icon.png',
      '128': 'icon.png',
    },
  },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  // The WorkspaceGPT Desktop bridge (src/lib/browserControl.ts, browserActions.ts):
  // on by default, so everything it needs is granted at install. debugger (real
  // clicks and keys, console and network logs) can only be a required
  // permission, so existing installs are disabled until re-approved.
  permissions: ['sidePanel', 'storage', 'alarms', 'scripting', 'debugger', 'tabGroups', 'nativeMessaging'],
  host_permissions: ['<all_urls>'],
});
