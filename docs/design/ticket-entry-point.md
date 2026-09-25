# WorkspaceGPT — Ticket Entry Point (Design)

> Status: **Built** — `get_ticket`, `TicketsMessageHandler` and the "Your work" home screen · Owner: Ritesh · Design last updated: 2026-08-24
>
> Makes the differentiator from [docs/north-star.md](../north-star.md) the *first thing
> a user sees*: not an empty chat box, but **their own tickets**, ready to work
> on. Two surfaces — a "Your work" list in the chat empty state, and `@`-mention
> of tickets in the composer — plus the precise ticket fetch the agent needs to
> act on them.
>
> This is the onboarding, the differentiator, and the demo, in one piece of work.

---

## 1. Why this, why now

Cursor, Claude Code, Codex, Cline and the rest all open the same way: an empty
box over your repo. They have to — the repo is all they know. **We know
something they don't**, and today we bury it: the user has to think to ask
"show my tickets" before anything org-aware happens.

Inverting that is cheap because the parts already exist:

| Needed | Already there |
|---|---|
| Authenticated ADO WIQL queries | `AdoService.getTotalItems` runs WIQL with a PAT ([adoService.ts](../../apps/vscode-extensions/src/services/ado/adoService.ts)) |
| Who "me" is | `config.ado.userDisplayName`, persisted by `fetchAndPersistUserIdentity` ([AdoMessageHandler.ts](../../apps/vscode-extensions/src/handlers/AdoMessageHandler.ts)) |
| Which sprint is current | `config.ado.currentSprint`, persisted alongside it |
| Agent that can act | `search_docs`, `search_tickets`, edit/create/delete, `run_command`, diagnostics, git — all live in the tool loop |
| Approval + rollback | write gate, diff cards, checkpoints |
| An `@`-picker to extend | `MentionPicker` + `SEARCH_MENTION_TARGETS` + `resolveMentions` |

So this is mostly **wiring**, not new capability. The one genuine gap is §3.

---

## 2. Design principles

1. **Offer, never block.** No modal, no "which ticket?" gate. Someone who
   wants "explain this file" must not pay a toll. The ticket list sits *beside*
   the composer, in space that today holds generic tips.
2. **A ticket is a starting point, not a mode.** Clicking one seeds the
   composer with an editable prompt. There is no separate "ticket mode" with
   its own rules — it's the normal agent loop with better context.
3. **Precise beats semantic for IDs.** Embedding search is the wrong tool for
   "fetch TKT-1234". Exact lookups get an exact API call (§3).
4. **Degrade honestly.** ADO not connected → the panel says so and links to
   Settings. Query fails → an error row, not an empty list that implies "you
   have no work".
5. **Local mode keeps working.** Ticket *fetch* is a live ADO call — the same
   network call Local mode already makes to sync ADO. It adds no new
   dependency and no vendor hop. Local mode stays intact.

---

## 3. The real gap: `get_ticket`

`search_tickets` is **semantic search over the synced RAG index**
(`searchKnowledge('ADO', …)` in [chatService.ts](../../apps/vscode-extensions/src/services/chatService.ts)).
That is right for "find tickets about checkout latency" and **wrong** for
"read TKT-1234":

- Embeddings are unreliable at exact-ID matching — the vector for `TKT-1234`
  sits near `TKT-1235`.
- The index only covers the `lookbackMonths` sync window, and is as stale as
  the last sync. A ticket assigned this morning may not be in it.
- Chunked/truncated payloads can drop acceptance criteria — the one field a
  code task most needs.

**Add a `get_ticket` tool** that fetches by ID from the live ADO API:

```
get_ticket({ id: "1234" | "TKT-1234" })
  → { id, title, type, state, assignedTo, sprint, url,
      description, acceptanceCriteria, parent?, comments? }
```

- Endpoint: `GET /_apis/wit/workitems/{id}?$expand=all&api-version=7.1`, same
  Basic-PAT auth `AdoService` already builds.
- Strip HTML from `System.Description` /
  `Microsoft.VSTS.Common.AcceptanceCriteria` to plain text (ADO stores HTML).
- Errors are actionable, in the pattern `searchKnowledge` established:
  404 → "no such work item"; 401/403 → "reconnect ADO in Settings".
- Prompt guidance ([promptTemplates.ts](../../apps/vscode-extensions/src/utils/promptTemplates.ts)):
  *ID in hand → `get_ticket`; describing a topic → `search_tickets`.*

This tool is what makes the ticket→code flow trustworthy, and it's useful on
its own even without either UI surface below.

---

## 4. Surface A — "Your work" in the chat empty state

Replaces the generic tips block when ADO is connected. Sits *above* the
existing "Recent Chats"/"Try asking" content, which stays.

```
┌─ Your work ───────────────── Sprint 24.6 ─┐
│ ● TKT-1418  Checkout retries on 502    ↻  │   ← state dot + title
│   Bug · Active                             │
│ ● TKT-1402  Add idempotency key            │
│   User Story · New                         │
│ ● TKT-1377  Flaky payment test             │
│   Bug · Active                             │
│                          See all in ADO ↗  │
└────────────────────────────────────────────┘
```

- **Query** (WIQL, same shape as the existing `getTotalItems` call):
  ```sql
  SELECT [System.Id] FROM WorkItems
  WHERE [System.TeamProject] = @project
    AND [System.AssignedTo] = @Me
    AND [System.State] NOT IN ('Closed','Removed','Done')
  ORDER BY [System.ChangedDate] DESC
  ```
  `@Me` is server-side — no need to interpolate `userDisplayName` (keep the
  stored name for display only, and it sidesteps a WIQL injection seam).
  Then one batch `GET /_apis/wit/workitemsbatch` for the display fields.
- **Sprint scoping**: if `config.ado.currentSprint` is set, add
  `AND [System.IterationPath] = @currentIteration` and label the header with
  the sprint name; otherwise show "Assigned to you" with no sprint chip.
- **Caching**: results cached in `globalState` with a timestamp; render cache
  instantly, refresh in the background, manual ↻. The empty state must never
  wait on a network call.
- **Click** → seeds the composer (does **not** auto-send — the user stays in
  control of the first move):
  > `Work on TKT-1418 — read the ticket, find the code it affects, and propose a plan before changing anything.`
- **States**: not connected → "Connect Azure DevOps to see your tickets here →
  Settings"; connected but empty → "Nothing assigned to you in this sprint";
  failed → "Couldn't reach Azure DevOps" + retry.

### Why "propose a plan before changing anything"

The seeded prompt deliberately asks for a plan first. A ticket is a large,
under-specified task — the failure mode is the agent charging into edits on a
misread. Plan-first mirrors the `release-core` spine (plan → approve → apply)
that the deployment feature already uses, and it makes the org-context step
*visible*: the user sees it read the ticket and the design doc before code.

---

## 5. Surface B — ticket `@`-mentions

Today `MentionTarget` is `{ path, name, kind: 'file' | 'folder' }`
([constants.ts](../../apps/vscode-extensions/constants.ts)). Extend it so tickets are
mentionable in any sentence — "fix @TKT-1418 in @src/checkout/retry.ts" — which
is exactly the code⊕org fusion nothing else offers.

```ts
export interface MentionTarget {
  /** Inserted after "@": a workspace path, or a ticket ID for kind 'ticket'. */
  path: string;
  name: string;
  kind: 'file' | 'folder' | 'ticket';
  /** Ticket only: secondary line in the picker (type · state). */
  detail?: string;
}
```

- **Search**: `handleSearchMentionTargets` currently calls only
  `searchMentionTargets` (files). Make it run file search and ticket search in
  parallel and merge. Ticket search triggers when the query looks like a ticket
  (`/^[A-Za-z]*-?\d+$/`) or matches a cached assigned-ticket title; files stay
  first for everything else so normal file mentioning is unaffected.
- **Resolution**: `resolveMentions` ([mentionResolver.ts](../../apps/vscode-extensions/src/services/codebase/mentionResolver.ts))
  tries file → folder → "could not read". Add a ticket branch **before** those,
  keyed off `kind`, returning the `get_ticket` payload as prompt text. The
  existing "never silently drop an unresolvable mention" rule carries over.
- **Wire format**: mentions currently travel as `string[]`. Tickets need their
  kind, so send `{ path, kind }[]` and normalize legacy strings to
  `kind: 'file'` on the host — same tolerant-decode pattern as
  `decodeShareCode`'s v1/v2 handling.
- **Icon**: a ticket glyph beside the existing file/folder icons in
  `MentionPicker`.

---

## 6. What the demo becomes

With §3–§5 in place, the three-minute video is a single unbroken take:

1. Open the sidebar → **your actual tickets are listed**. (No other agent can
   show this frame.)
2. Click one → composer seeded → send.
3. Agent calls `get_ticket` → reads acceptance criteria → `search_docs` finds
   the design page → `search_codebase`/`find_symbol` locates the code → posts
   a plan citing ticket *and* doc.
4. Approve → `edit_file` diff cards → `run_command` runs the tests →
   `get_diagnostics` confirms clean.
5. Every step revertable from the checkpoint timeline.

That is the whole positioning, demonstrated rather than claimed. Note steps
3–5 already work today — this design only supplies steps 1–2 and the precise
ticket read.

---

## 7. Build order

| Step | Deliverable | Depends on | Value alone |
|---|---|---|---|
| 1 | `get_ticket` tool + prompt guidance (§3) | nothing | **DONE** — `adoWorkItemService.ts` (live by-ID read, org-agnostic prefix stripping, structure-preserving HTML→text, opt-in comments), tool def in `modelWorker.ts`, dispatch + timeline/summary/status strings in `chatService.ts`, prompt guidance in `promptTemplates.ts`. 18 pure-function assertions green; host type-checks and builds. **Pending live verification against a real ticket.** |
| 2 | `listMyWorkItems()` + cache + `GET_MY_WORK_ITEMS` message | nothing | **DONE (no UI consumer yet)** — `listMyWorkItems` in `adoWorkItemService.ts` (WIQL `@Me` + `workitemsbatch`, current-sprint-first ordering), `GET_MY_WORK_ITEMS`/`_RESPONSE` message types, cache-first handler in `AdoMessageHandler` (posts cache then fresh; a failed refresh keeps the cache and reports the error), cache cleared on ADO disconnect. 14 assertions green. **Pending live verification.** |
| 3 | "Your work" panel in the empty state (§4) | 2 | **DONE** — `MyWorkPanel.tsx` + wiring in `App.tsx` (fetch on ADO-connect, cache-then-fresh, manual ↻, click seeds the composer without sending) + styles in `App.css`. 15 render assertions green across loading/empty/error/overflow/stale-cache states. **Pending live verification.** |
| 4 | `MentionTarget.kind: 'ticket'` end-to-end (§5) | 1, 2 | The code⊕org fusion in one sentence |
| 5 | Seeded plan-first prompt tuning + eval on 5 real tickets | 1–4 | Turns "it works" into "it's good" |

Steps 1 and 2 are independent and can land in either order. Step 3 is the
smallest slice that changes the product's first impression.

---

## 8. Open items

| # | Question | Notes |
|---|---|---|
| 1 | ~~Ticket ID format per org~~ | **Resolved for `get_ticket`**: `parseWorkItemId` takes the trailing digit run, so `1234` / `TKT-1234` / `D2C-4312` / `#1234` all work with no org string in the engine. The §5 mention regex must follow the same rule. |
| 2 | ~~Include ticket comments?~~ | **Resolved**: implemented as opt-in `includeComments` (off by default); the tool description tells the model to request them only when description + acceptance criteria are too thin. A comments fetch failure degrades to `[]` rather than failing the read. |
| 3 | Should the "Your work" list also show ADO PRs assigned for review? | Natural extension, separate API; defer to v2 |
| 4 | ~~Sprint detection when no team is configured~~ | **Resolved by design**: sprint is no longer a WIQL filter. All open assigned items are fetched and current-sprint membership is decided client-side from the stored `iterationPath`, so undetected sprint (or an unexpected path format) degrades to "no sprint grouping" instead of an empty list. `isInCurrentSprint` handles exact + sub-iteration matches without the `Sprint 2`/`Sprint 20` prefix collision. |
| 5 | Does "assigned to me" need Jira parity later? | Only ADO + Confluence are live today; keep the panel's data shape source-agnostic so a Jira adapter can fill it |
