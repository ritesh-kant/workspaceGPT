# Work brief — "Ask about my work"

Status: phase 1 + 2 built on `feat/proactive-mode` (2026-11-16).

First real run (2026-11-16, dev desktop app, the author's profile, which has
Confluence, GitHub and call notes but no Azure DevOps or Jira connected):
- The brief built in 12.5 s from 112 calls, 64 pages and 354 PRs.
- Answers came back in 3.8–8.5 s with correct source chips.
- Two fixes came out of it:
  - The model misjudged "last two weeks" against bare dates, so the prompt now gives explicit cut-off dates.
  - The model shortened long GitHub tags, so a shortened id now links when exactly one shown item ends with it.
- The overlay window opened at 44×44, top-right, floating, and excluded from
  screen capture (window sharing state 0). On a two-screen setup it first
  appeared on the built-in display. It now opens on the main window's screen.
- The user confirmed that clicking the icon opens the panel.

## What it is

A second brain for the user's own work. It answers questions like "where are we
on the refund bug?" in a few seconds, without the agent's tool loop, so the
user can answer someone during a call.

- **Window:** a fixed 365 days.
- **Ask-only:** nothing listens to calls or shows answers unprompted.
- **Desktop:** a small icon floats in the top-right corner of the screen and is
  hidden from screen sharing. A click opens the ask panel.
- **VS Code:** the command palette has *WorkspaceGPT: Ask About My Work*.

## Why it is fast

Synced Knowledge is already on disk. The agent is slow because it makes 5–15
tool calls and model round trips. The brief is written in advance, so a
question becomes **one model call with no tools**: the brief, then the
question, then a 1–3 sentence answer the user can say aloud, with cited ids.

## Data: what counts as "mine"

`services/workBrief/fetchMyWork.ts` asks each source for the user's own items
only. It is separate from the project syncs (`lookbackDays`, whole project), so
a year of data stays small.

| Source | Query |
|---|---|
| Azure DevOps work items | WIQL, org-wide: `AssignedTo EVER @Me OR CreatedBy = @Me OR ChangedBy EVER @Me`, changed in 365 days. If the org rejects `EVER` (400), the plain query runs instead. |
| Azure DevOps PRs | Connected project, `creatorId` and `reviewerId` = me, `status=all`, created in the window |
| Jira | `assignee = currentUser() OR reporter = currentUser() OR assignee WAS currentUser() OR issuekey IN updatedBy(currentUser(), "-365d")`. If that returns 400, it falls back to assignee/reporter only. |
| Confluence | CQL `contributor = currentUser() AND type IN (page, blogpost)`, modified in 365 days |
| GitHub | `gh search prs --author @me` / `--reviewed-by @me` through an existing GitHub CLI sign-in |
| Call notes | On-device notes; uses the summary (tldr, highlights, decisions, my actions) when one exists |

If a source fails, the brief records a note and keeps the other sources. A
source the user never connected is skipped quietly. The result is stored at
`<globalStorage>/work-brief/brief.json`, on this machine only. Each item is
saved as plain fields: tag, kind, state, roles, people, dates, where, and a
detail excerpt. No model is used to build it, so building is free and nothing
in it is invented.

## Prompt: three tiers

`services/workBrief/brief.ts` (pure, unit-tested):

| Tier | What | Budget |
|---|---|---|
| Hot | Updated in the last 30 days, **or** open according to the source → full card | 80k chars (~20k tokens) |
| Warm | Everything else → one line each | 60k chars (~15k tokens) |
| Cold | Full card of a warm or unlisted item, picked per question by a local lookup (an id said in the question, then rare-word overlap with title/detail) | ≤ 5 cards |

The stable brief comes first and the question last, so a provider's prompt
cache can reuse the brief across questions. "Open" never hides an item; it can
only promote one to a full card. A hot item that doesn't fit the card budget
drops to a line, and an item with no room even as a line is still reachable
through the lookup.

Measured with a seeded brief of 401 items: the prompt was 55 KB (~14k tokens),
and a 200-day-old item the question named was added as a full card.

## Answer rules

- Answer only from the brief. If the answer isn't there, reply "Not in your brief." plus one line on what to look up.
- 1–3 sentences in the first person, citing `[TAG]` for each item used.
- **Provenance:** a source chip appears only for a tag the answer cites *and*
  the prompt showed. A made-up id gets no link (`citedSources`).
- If the brief is older than 6 h, it rebuilds in the background on the next
  question. A first question with no brief builds it first. The status line
  says "Building your brief…".

## Desktop overlay

| Piece | Where |
|---|---|
| Window `cue` (44×44, grows to 380×440 keeping its right edge) | `src-tauri/src/cue.rs` |
| Transparent, always on top, no taskbar, on all Spaces, **`content_protected`** (hidden from screen capture) | same |
| Show/hide | App menu → *Show Work Brief Icon* (on by default, stored in `cue.json`) |
| Page | `bridge/cue.html`, `cue.ts`, `cue.css` |
| Socket `/__desktop/cue` (token + Origin checked like the view sockets) | `sidecar/host/server.ts`, `sidecar/host/cueHost.ts` |
| Expand/collapse | Cancelled navigation `workspacegpt://cue/expand` / `collapse`, the same no-IPC pattern as `refresh-layout` |
| Move | The panel header is a `data-tauri-drag-region` (`window-drag` capability now lists `cue`) |

`macOSPrivateApi` / the `macos-private-api` feature are on because macOS
transparent windows need them. The app is not distributed through the Mac App
Store.

## Privacy

Everything is built from the user's own sources and stored in globalStorage.
Only one question's prompt goes to the chosen model, the same as any chat.
Analytics events (`work_brief_asked`, `work_brief_built`) carry ok, timings and
counts, never content.

## Not built / next

- A global hotkey to summon the panel. It needs `tauri-plugin-global-shortcut`, a new crate.
- A dot on the icon during a call. Call detection exists, but nothing feeds the overlay yet.
- Comments the user wrote on tickets. The ADO revisions pass that covers "I commented" is also not done.
- GitLab/Bitbucket PRs.
- Giving the brief to the coding agent's prompt.
- Standup and 1:1 drafts built from the brief.
- An "Ask about my work" input inside the chat webview. VS Code has only the command for now.
- Verification still to do: real Knowledge (whether ADO `EVER` on `ChangedBy` is accepted, the Jira `updatedBy` fallback), a real model's answers, the packaged app's transparent window, content protection while screen sharing on Teams/Zoom, and Windows.
