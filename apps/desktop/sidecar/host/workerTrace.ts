/**
 * WGPT_DESKTOP_TRACE_WORKERS=1 — log every message crossing a worker_thread
 * boundary (type + size only, never contents), with the time since the
 * worker started. The agent loop lives in modelWorker and talks to the host
 * only through these messages, so this is how to see where a run is waiting:
 * a `tool_request` with no matching `tool_response` is the host; silence
 * after the worker starts is the model call.
 *
 * Wraps worker_threads.Worker on the module object, same technique (and same
 * reason) as processReaper.ts.
 */
import * as path from 'node:path';

export function installWorkerTrace(): void {
  if (process.env.WGPT_DESKTOP_TRACE_WORKERS !== '1') return;
  const wt = require('node:worker_threads');
  const Real = wt.Worker;
  const describe = (m: any) => {
    const type = m && typeof m === 'object' ? (m.type ?? m.kind ?? Object.keys(m).slice(0, 3).join(',')) : typeof m;
    let size = 0;
    try {
      size = JSON.stringify(m)?.length ?? 0;
    } catch {
      /* transferables */
    }
    const extra = m?.name ? ` name=${m.name}` : m?.id !== undefined ? ` id=${m.id}` : '';
    return `${type}${extra} (${size} B)`;
  };
  wt.Worker = class TracedWorker extends Real {
    constructor(file: any, opts?: any) {
      super(file, opts);
      const label = path.basename(String(file));
      const started = Date.now();
      const t = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`;
      console.log(`[trace ${label}] started`);
      this.on('message', (m: any) => console.log(`[trace ${label}] ${t()} worker→host ${describe(m)}`));
      this.on('error', (e: any) => console.log(`[trace ${label}] ${t()} error ${e?.message ?? e}`));
      this.on('exit', (code: number) => console.log(`[trace ${label}] ${t()} exit ${code}`));
      const post = this.postMessage.bind(this);
      this.postMessage = (m: any, transfer?: any) => {
        console.log(`[trace ${label}] ${t()} host→worker ${describe(m)}`);
        return post(m, transfer);
      };
    }
  };
}
