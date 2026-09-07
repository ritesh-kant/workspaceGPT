/**
 * A scripted OpenAI-compatible chat endpoint, so the agent loop can be driven
 * end-to-end with no API key and no nondeterminism.
 *
 * This is not a model substitute — it cannot tell us whether a real model
 * behaves better. It answers the other half of the question, which no live run
 * answers cheaply: do the harness MECHANISMS actually fire inside the real
 * worker? A scripted run can assert that the commit nudge reaches the model's
 * messages, that `explore` really runs a sub-loop, that a fabricated report
 * gets stamped, and that a numbered read survives the round trip into
 * edit_file — each of which was "unverified" while only unit tests existed.
 *
 * Turns are served from a script. Sub-agent requests are told apart from main
 * loop requests by their TOOL SET: the `explore` sub-agent is offered a
 * read-only subset with no edit_file in it, which is a structural signal and
 * needs no cooperation from the script.
 */
import * as http from 'http';

/**
 * The pre-loop exploration phase's explorers are TOOL-LESS completions, so
 * they look like the forced-answer turn unless they are told apart by their
 * system preamble. Serving them from the main script instead would consume a
 * scripted turn and desynchronise everything after it.
 */
const EXPLORER_PREAMBLE_RE = /You are a code-reading assistant/;
const EXPLORER_DEFAULT = '{"claims":[],"entryPoints":[],"unknowns":["scripted run: no preliminary scan"]}';

/**
 * `fail` lets a test play a provider that REFUSES a request rather than
 * answering it: it is handed the parsed body and returns `{ status, body }` to
 * reject with, or null/undefined to serve the script as usual. A rejection
 * does not consume a scripted turn, so the retry that follows gets the turn
 * the failed attempt would have had — which is what makes a strip-and-retry
 * assertable end to end.
 */
export function startMockModel({ main = [], explore = [], onRequest, fail } = {}) {
  const state = { mainIndex: 0, exploreIndex: 0, preloopCalls: 0, requests: [] };

  const nextFrom = (script, index) => (index < script.length ? script[index] : script[script.length - 1]);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        /* fall through to an empty request — the script decides what to say */
      }
      const toolNames = (parsed.tools ?? []).map((t) => t?.function?.name).filter(Boolean);
      const isSubAgent = toolNames.length > 0 && !toolNames.includes('edit_file');
      const withoutTools = toolNames.length === 0;

      const systemText = String((parsed.messages ?? []).find((m) => m?.role === 'system')?.content ?? '');
      const isPreloopExplorer = withoutTools && EXPLORER_PREAMBLE_RE.test(systemText);
      if (isPreloopExplorer) state.preloopCalls++;

      const rejection = fail?.(parsed);
      if (rejection) {
        state.requests.push({
          subAgent: isSubAgent,
          preloopExplorer: isPreloopExplorer,
          withoutTools,
          toolCount: toolNames.length,
          toolNames,
          messages: parsed.messages ?? [],
          rejectedWith: rejection.status,
        });
        onRequest?.(state.requests[state.requests.length - 1]);
        res.writeHead(rejection.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rejection.body ?? {}));
        return;
      }

      const turn = isPreloopExplorer
        ? { finalContent: EXPLORER_DEFAULT }
        : isSubAgent
          ? nextFrom(explore, state.exploreIndex++)
          : nextFrom(main, state.mainIndex++);

      state.requests.push({
        subAgent: isSubAgent,
        preloopExplorer: isPreloopExplorer,
        withoutTools,
        toolCount: toolNames.length,
        toolNames,
        messages: parsed.messages ?? [],
      });
      onRequest?.(state.requests[state.requests.length - 1]);

      // A no-tools request is the forced-answer turn: never hand back tool
      // calls there, or the worker would (correctly) treat them as leaked.
      const wantsTools = !withoutTools && Array.isArray(turn?.toolCalls) && turn.toolCalls.length > 0;
      const message = wantsTools
        ? {
            role: 'assistant',
            content: turn.content ?? null,
            tool_calls: turn.toolCalls.map((tc, i) => ({
              id: `call_${state.mainIndex}_${i}`,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
            })),
          }
        : { role: 'assistant', content: turn?.finalContent ?? turn?.content ?? '(no content)' };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          model: parsed.model ?? 'mock',
          choices: [{ index: 0, message, finish_reason: wantsTools ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
