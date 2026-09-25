import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'WorkspaceGPT',
  version: '0.2.0',
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
  // alarms/scripting carry no install warning, so adding them does not
  // disable existing installs. The WorkspaceGPT Desktop browser bridge
  // (src/lib/browserControl.ts) needs the two that do — native messaging and
  // every site — and asks for them only when the user turns it on.
  permissions: ['sidePanel', 'storage', 'alarms', 'scripting'],
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
