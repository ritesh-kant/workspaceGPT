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
  // Hosts the extension calls directly. Qdrant Cloud uses *.qdrant.io; localhost
  // covers self-hosted Qdrant. The rest are the supported LLM/embedding endpoints.
  host_permissions: [
    'https://generativelanguage.googleapis.com/*',
    'https://*.qdrant.io/*',
    'https://*.vercel.app/*', // proxy mode: WorkspaceGPT proxy deployed on Vercel
    'http://localhost/*',
    'https://api.openai.com/*',
    'https://api.groq.com/*',
    'https://openrouter.ai/*',
    'https://integrate.api.nvidia.com/*',
  ],
});
