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
  // The extension only ever talks to the WorkspaceGPT Worker, which proxies all
  // retrieval + chat. No direct calls to Qdrant / Gemini / LLM providers.
  host_permissions: [
    'https://*.workers.dev/*',
    'http://localhost/*', // wrangler dev
  ],
});
