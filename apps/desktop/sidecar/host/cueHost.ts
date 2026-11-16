/**
 * The work-brief icon overlay (bridge/cue.html, a small always-on-top window
 * the shell opens) talks to the extension's work brief over its own socket,
 * /__desktop/cue. The page holds nothing: every answer comes from the
 * extension's commands (services/workBrief/workBrief.ts).
 *
 *   page → host  {t:'status'} | {t:'ask', id, q} | {t:'refresh'} | {t:'open', url}
 *   host → page  {t:'status', status} | {t:'answer', id, result} | {t:'error', id?, message}
 */
import type { WebSocket } from 'ws';

export interface CueHostDeps {
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  openExternal(url: string): Promise<unknown>;
  log?: (line: string) => void;
}

export function createCueHost(deps: CueHostDeps) {
  return {
    attach(ws: WebSocket) {
      const send = (msg: unknown) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      };
      const status = async () => {
        try {
          send({ t: 'status', status: await deps.executeCommand('workspacegpt.workBrief.status') });
        } catch (err) {
          send({ t: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      };
      ws.on('message', async (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg?.t === 'status') return void status();
        if (msg?.t === 'refresh') {
          // Show "building" at once; the finished status follows.
          const done = deps.executeCommand('workspacegpt.workBrief.refresh');
          await status();
          await done.catch(() => undefined);
          return void status();
        }
        if (msg?.t === 'ask' && typeof msg.q === 'string') {
          const id = msg.id;
          try {
            const pending = deps.executeCommand('workspacegpt.workBrief.ask', msg.q.slice(0, 2000));
            // A first question builds the brief; let the page say so.
            void status();
            send({ t: 'answer', id, result: await pending });
          } catch (err) {
            send({ t: 'error', id, message: err instanceof Error ? err.message : String(err) });
          }
          return void status();
        }
        if (msg?.t === 'open' && typeof msg.url === 'string' && /^https:\/\//i.test(msg.url)) {
          await deps.openExternal(msg.url);
        }
      });
      deps.log?.('[desktop] work brief overlay connected');
      void status();
    },
  };
}
