# WorkspaceGPT for Chrome

A side panel that asks **WorkspaceGPT Desktop** your questions, and lets the
desktop agent use the tabs in this Chrome profile. The extension holds **no
model, no API key and no index** — everything runs in the desktop app. The
system as a whole is described in [docs/architecture.md](../../docs/architecture.md).

```
side panel ──connect()──▶ service worker ──connectNative──▶ browser-relay ──socket──▶ desktop host
(src/sidepanel)           (src/lib/browserControl.ts)       (apps/desktop/sidecar)   (src/services/browser/)
```

One native-messaging port to `com.workspacegpt.bridge` carries both directions:

| Direction | Message | What it is |
| --- | --- | --- |
| desktop → extension | `request` / `response` | Browser control: list tabs, click, type, screenshot (`browserActions.ts`) |
| extension → desktop | `ask` / `event` | A side-panel question; the desktop streams back `status`, `chunk`, `restart`, `done`, `error` |

## Who decides the provider

The desktop. A `chat` ask is run by `apps/vscode-extensions/src/services/browser/chromeChat.ts`
as an ordinary chat session (`chrome-<id>`), using the provider and model picked
in Desktop's Settings → Model (Copilot, an API key, or Remote), the local index
and the Knowledge sources. The panel only renders the stream. Nothing about a
provider, key or Copilot token ever reaches Chrome.

- The panel cannot answer review cards, so anything that would wait on one
  (a file write, a command, a Confluence write, an `ask_user` question) is
  declined and the model is told to answer without it.
- Closing the panel stops its run on the desktop.
- Follow-ups in one open panel share one desktop session.

## Using it

1. Install and open WorkspaceGPT Desktop (0.0.5+); pick a model in Settings → Model.
2. Ask. The connection is always on (native messaging and site access are
   granted at install) and works only while the desktop app is running;
   ⚙ Settings shows whether it is connected.

## Build

```bash
cd apps/chrome-extension && pnpm build   # load dist/ unpacked
pnpm package                             # zip for the Chrome Web Store
```

## History

Until 2026-10 this was a standalone client: a "share code" from VS Code carried
Gemini, Qdrant and LLM keys into Chrome, which searched and generated on its
own. That path (and its Gemini/Qdrant host permissions) was removed because the
index is on-device only and sharing keys defeats the privacy model. The Vercel
function `apps/confluence-auth-proxy` is unrelated (Confluence OAuth only).

## Not verified yet

- A run in real Chrome: the wire path is tested through the real sidecar with a
  fake extension client and a mock model (ask → agent run → streamed chunks →
  done), but the panel UI and the service worker relay have not been driven in a
  browser.
- Copilot and Remote as the selected provider via this path.
