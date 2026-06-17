// Base URL of the deployed WorkspaceGPT Cloudflare Worker. Override at build
// time with VITE_WORKER_URL; defaults to the production deployment.
export const WORKER_URL = (
  import.meta.env.VITE_WORKER_URL ?? 'https://workspacegpt-worker.workers.dev'
).replace(/\/+$/, '');
