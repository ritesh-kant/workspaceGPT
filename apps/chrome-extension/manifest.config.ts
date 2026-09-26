import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'WorkspaceGPT',
  version: '0.3.0',
  description:
    'Ask questions about your Confluence & Azure DevOps knowledge, in the browser.',
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
  // The WorkspaceGPT Desktop browser bridge (src/lib/browserControl.ts,
  // browserActions.ts). debugger — real clicks and keys, console and network
  // logs — can only be a required permission, so it disables existing
  // installs until re-approved (decided 2026-09-25 for parity with Claude in
  // Chrome / Codex). Native messaging and every-site access stay optional and
  // are asked for only when the user turns the bridge on.
  permissions: ['sidePanel', 'storage', 'alarms', 'scripting', 'debugger', 'tabGroups'],
  optional_permissions: ['nativeMessaging'],
  optional_host_permissions: ['<all_urls>'],
  // The extension talks directly to Gemini (query embedding), Qdrant (search),
  // and the configured LLM — all using credentials from the share code.
  host_permissions: [
    'https://generativelanguage.googleapis.com/*',
    'https://*.qdrant.io/*',
    'https://api.openai.com/*',
    'https://api.groq.com/*',
    'https://openrouter.ai/*',
    'https://integrate.api.nvidia.com/*',
  ],
});
