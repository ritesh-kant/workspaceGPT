/**
 * The work-brief icon overlay (bridge/cue.html, a small always-on-top window
 * the shell opens) talks to the extension's work brief over its own socket,
 * /__desktop/cue. The page holds nothing: every answer comes from the
 * extension's commands (services/workBrief/workBrief.ts).
 *
 *   page → host  {t:'status'} | {t:'ask', id, q, history?: {q, a}[]} | {t:'refresh'} | {t:'open', url}
 *   host → page  {t:'status', status} | {t:'answer', id, result} | {t:'error', id?, message}
 *                | {t:'listening', on}   (call notes is recording a call)
 *                | {t:'partial', id, text}   (the answer so far, before its 'answer')
 */
import type { WebSocket } from 'ws';

export interface CueHostDeps {
  executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  openExternal(url: string): Promise<unknown>;
  log?: (line: string) => void;
}

export function createCueHost(deps: CueHostDeps) {
  const sockets = new Set<WebSocket>();
  let listening = false;
  return {
    /** Call notes started or stopped recording a call. */
    setListening(on: boolean) {
      if (on === listening) return;
      listening = on;
      for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'listening', on }));
    },
    attach(ws: WebSocket) {
      const send = (msg: unknown) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      };
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
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
            // Earlier turns of this conversation, so a follow-up knows what "it" is.
            const history = Array.isArray(msg.history)
              ? msg.history.slice(-6).filter((t: any) => typeof t?.q === 'string' && typeof t?.a === 'string')
              : [];
            const partial = (text: string) => send({ t: 'partial', id, text });
            const pending = deps.executeCommand('workspacegpt.workBrief.ask', msg.q.slice(0, 2000), history, partial);
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
      send({ t: 'listening', on: listening });
    },
  };
}
