import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'WorkspaceGPT',
  version: '0.1.0',
  description:
    'Ask questions about your Confluence & Azure DevOps knowledge, in the browser.',
  action: { default_title: 'WorkspaceGPT' },
  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  permissions: ['sidePanel', 'storage'],
  // The extension talks directly to Gemini (query embedding), Qdrant (search),
  // and the configured LLM — all using credentials from the share code.
  host_permissions: [
    'https://generativelanguage.googleapis.com/*',
    'https://*.qdrant.io/*',
    'https://api.openai.com/*',
    'https://api.groq.com/*',
    'https://openrouter.ai/*',
    'https://integrate.api.nvidia.com/*',
    'http://localhost/*',
  ],
});
