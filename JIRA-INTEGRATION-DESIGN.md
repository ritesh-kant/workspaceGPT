# WorkspaceGPT — Jira Integration (Design)

> Status: **Draft for review** · Owner: Ritesh · Last updated: 2026-09-15
>
> Brings Jira to parity with the Azure DevOps integration, by first extracting
> the **provider seam** that ADO is currently fused to, then implementing Jira
> as the second provider behind it.
>
> ADO is ~3,540 LOC across 9 dedicated files plus coupled logic in ~20 more.
> Cloning that for Jira is ~7 days faster to first working build and leaves two
> divergent 3.5k-LOC codepaths to maintain forever. This document takes the
> other path: extract the interface, migrate ADO onto it, add Jira beside it.
> Tracker #3 (Linear, GitHub Issues) then costs ~8–12 days instead of ~30.

---

## 0. Scope decision — read this first

**v1 is Jira Cloud only.** Jira Server / Data Center is effectively a second
integration, not a config flag:

| | Cloud | Server / DC |
|---|---|---|
| Rich text | ADF (JSON) | Wiki markup |
| Auth | API token (Basic) or OAuth 2.0 3LO | PAT |
| Search | `/rest/api/3/search/jql`, token pagination | `/rest/api/2/search`, `startAt` |
| Sprint | Agile API + board discovery | Agile API, different shape |

Supporting both adds roughly **40%** to every phase below. Settle this before
anyone commits to a date — it is the single biggest swing in the estimate.

**Naming collision to avoid.** `SourceProvider = … | 'jira' | …` already exists
in [constants.ts](apps/vscode-extensions/constants.ts) — that is the
**deployment/release roster** source in `release-core`, an unrelated feature.
This document never touches it. Nothing here should be named `SourceProvider`.

---

## 1. What "ADO parity" actually means

The inventory this design has to reproduce:

| Feature | Where | LOC |
|---|---|---|
| Auth — 3 modes (MSAL, `az cli`, PAT) + 20-min token refresh | [adoAuthService.ts](apps/vscode-extensions/src/services/ado/adoAuthService.ts) | 368 |
| Live ticket read + comments + inline images→base64 for vision | [adoWorkItemService.ts](apps/vscode-extensions/src/services/ado/adoWorkItemService.ts) | 495 |
| Bulk sync worker — WIQL, batched fetch, concurrent comments, md conversion | [adoWorker.ts](apps/vscode-extensions/src/workers/ado/adoWorker.ts) | 363 |
| Embedding/indexing into the `'ADO'` namespace | [adoEmbeddingService.ts](apps/vscode-extensions/src/services/ado/adoEmbeddingService.ts) | 486 |
| Resumable sync + progress persistence | [adoService.ts](apps/vscode-extensions/src/services/ado/adoService.ts) | 321 |
| Scheduled background sync | [adoSyncScheduler.ts](apps/vscode-extensions/src/services/ado/adoSyncScheduler.ts) | 202 |
| 16 webview message cases, org/project discovery, identity | [AdoMessageHandler.ts](apps/vscode-extensions/src/handlers/AdoMessageHandler.ts) | 605 |
| Settings UI | [AdoSettings.tsx](apps/vscode-extensions/webview/src/components/settings/AdoSettings.tsx) | 380 |
| My Work panel + sprint detection/ordering | [MyWorkPanel.tsx](apps/vscode-extensions/webview/src/components/MyWorkPanel.tsx) | 207 |

Plus thin-but-wide coupling that is easy to miss when scoping:

- `search_tickets` / `get_ticket` tool defs ([modelWorker.ts](apps/vscode-extensions/src/workers/model/modelWorker.ts)) and their dispatch ([chatService.ts](apps/vscode-extensions/src/services/chatService.ts))
- `ToolAvailability.ado` gating ([toolScope.ts](apps/vscode-extensions/src/workers/model/toolScope.ts))
- ADO URL/filename regexes and `work-item` ref kind ([referenceIndex.ts](apps/vscode-extensions/src/services/agent/referenceIndex.ts))
- `#<id>` → `dev.azure.com` citation linking ([ticketRefs.ts](apps/vscode-extensions/webview/src/utils/ticketRefs.ts))
- Source routing ([queryClassifier.ts](apps/vscode-extensions/src/utils/queryClassifier.ts), [turnRouting.ts](apps/vscode-extensions/src/utils/turnRouting.ts))
- Ship write-back — `AB#<id>` trailer, branch type from work-item type, report posted as an HTML comment ([shipService.ts](apps/vscode-extensions/src/services/agent/shipService.ts))
- MCP `search_ado` tool ([searchTools.ts](apps/workspacegpt-mcp/src/tools/searchTools.ts)) and its data-dir probe ([dataDir.ts](apps/workspacegpt-mcp/src/utils/dataDir.ts))
- Chrome extension `'ADO'` source ([retrieval.ts](apps/chrome-extension/src/lib/retrieval.ts))

> **`packages/jira-utils` is not a head start.** It and `packages/azure-devops-utils`
> are stale `dist/`-only build leftovers from March with no `src` and no
> `package.json`. Delete both as part of P0.

---

## 2. Design principles

1. **The seam goes where the providers actually differ.** A `TicketProvider`
   interface over fetch/search/comment is worth it. Abstracting the *sync
   worker* is not — WIQL batching and JQL token pagination differ enough that a
   shared base class would be two implementations wearing one coat.
2. **`id` is a string, everywhere, from day one.** See §3. This is not a Jira
   concession; it is the assumption ADO baked in that has to come out first.
3. **Capability from facts, not keywords.** `ToolAvailability` grows a
   `tickets: boolean` derived from "any tracker authenticated" — never from
   parsing the user's text. Same rule as
   [toolScope.ts](apps/vscode-extensions/src/workers/model/toolScope.ts) states today.
4. **Tool names stay provider-neutral.** `search_tickets` and `get_ticket`
   already are. The model must not learn `search_jira` vs `search_ado` — that
   is a prompt tax per provider and invites failed calls.
5. **One tracker connected at a time, in v1.** Multi-tracker is a data-model
   question (namespace collision, ref disambiguation) that does not need
   answering to ship Jira. §9.
6. **Degrade honestly.** Same rule as the ticket entry point: a tracker that is
   not connected says so and links to Settings; a failed query is an error row,
   never an empty list that implies "you have no work".

---

## 3. P0 — The ID model (do this first, alone)

`TicketDetail.id` is `number`. `parseWorkItemId` deliberately takes the
*trailing digit run*, documented in
[adoWorkItemService.ts](apps/vscode-extensions/src/services/ado/adoWorkItemService.ts)
as correct because ADO work items are plain integers and `TKT-`/`D2C-` prefixes
are org conventions the engine must not learn.

For Jira the prefix **is** the identity: `PROJ-123`. The trailing-digit rule
silently produces `123`, which resolves to the wrong issue or none.

This ripples further than it looks:

| Site | Today | After |
|---|---|---|
| `TicketDetail.id`, `parentId` | `number` | `string` |
| `parseWorkItemId(raw): number` | trailing digits | provider-supplied parser, returns canonical key |
| `ticketRefs` `#<id>` regex | 4+ digits, so `#3` and CSS colors never match | keep the digit floor for numeric ids; add a `#?[A-Z][A-Z0-9]+-\d+` alternative |
| `shipService` `AB#${id}` trailer | ADO smart-commit syntax | provider-supplied trailer (Jira uses the bare key) |
| `shipService.ticketId?: number` | | `string` |
| `referenceIndex` `ADO-(\d+)` / `_workitems/edit/(\d+)` | | provider-supplied id extractors |
| `MY_WORK_ITEMS_CACHE`, sync progress `lastProcessedId` | mixed | string throughout |

Doing this as its own commit, with ADO still the only provider and its tests
green, is what keeps it from contaminating every later phase.

**Effort: 3–4 d.**

---

## 4. P1 — The provider seam

### 4.1 The interface

```ts
/** A ticket tracker. One implementation per vendor; see NORTH-STAR.md §1. */
export interface TicketProvider {
  /** Stable key: 'ado' | 'jira'. Used for storage keys, namespaces, telemetry. */
  readonly kind: TrackerKind;
  /** Display name for the context picker and Settings ('Azure DevOps', 'Jira'). */
  readonly label: string;

  /** Is this tracker authenticated right now? Feeds ToolAvailability. */
  isConnected(): Promise<boolean>;

  /** One ticket, live and complete — the `get_ticket` path. */
  fetchTicket(id: string, opts: { includeComments: boolean }): Promise<TicketDetail>;

  /** Tickets assigned to the current user — the My Work panel. */
  listMyTickets(): Promise<MyTicketsResult>;

  /** Post the run's report back on the ticket. Body is markdown; the
   *  provider renders to whatever its API wants (ADO: HTML, Jira: ADF). */
  addComment(id: string, markdown: string): Promise<void>;

  /** User-typed reference → canonical id, or throw with a usable message. */
  parseId(raw: string): string;

  /** Deep link to the ticket in the vendor's UI. */
  ticketUrl(id: string): string | null;

  /** Ids this provider recognises in free text / search hits, for referenceIndex. */
  readonly idPatterns: { url: RegExp; filename: RegExp; prose: RegExp };

  /** Commit trailer that links a commit to this ticket ('AB#123' / 'PROJ-123'). */
  commitTrailer(id: string): string;
}
```

Deliberately **not** on the interface: sync, indexing, auth UI, org/project
discovery. Those stay per-provider (§2.1) and are reached through the existing
message-handler path, not through this object.

### 4.2 Registry, replacing the hardcoded unions

Five places hardcode the source union and all must become registry lookups:

- [types.ts:46](apps/vscode-extensions/src/types/types.ts) — `DataSource = 'CONFLUENCE' | 'ADO' | 'CODEBASE'`
- [types.ts:23](apps/vscode-extensions/src/types/types.ts) — `sourceName: 'CONFLUENCE' | 'ADO'`
- [searchProcess.ts:24,78,441](apps/vscode-extensions/src/workers/common/searchProcess.ts) — `currentNamespace`
- [embeddingManifest.ts:24](packages/embedding-core/src/embeddingManifest.ts) — `source: 'CONFLUENCE' | 'ADO'`
- [retrieval.ts](apps/chrome-extension/src/lib/retrieval.ts) — the extension's own copy

The vector store itself is namespace-agnostic; only these type unions and the
`namespace: 'ADO'` literals in
[adoEmbeddingService.ts](apps/vscode-extensions/src/services/ado/adoEmbeddingService.ts)
pin it. Adding `'JIRA'` is a type change plus a data-dir entry, not a storage
migration.

### 4.3 Tool availability

`ToolAvailability.ado: boolean` → `tickets: boolean`, and
`TOOL_REQUIREMENTS.search_tickets/get_ticket` point at it. The prompt text in
[promptTemplates.ts](apps/vscode-extensions/src/utils/promptTemplates.ts) that
says "Azure DevOps" becomes the active provider's `label`.

`turnRouting`'s context-picker case `'Azure DevOps' → 'ADO'` becomes a registry
lookup over `label → kind`.

**Effort: 5–7 d** (interface + migrating ADO onto it + the union removals, with
ADO still the only provider and tests green).

---

## 5. P2–P8 — Jira as the second provider

### P2 · Auth + site/project discovery — 3–4 d

v1 ships **API token only**: `Basic base64(email:token)`, stored in
`context.secrets` exactly as the ADO PAT is. This is *simpler* than the MSAL
flow already built.

Discovery mirrors `FETCH_ADO_ORGANIZATIONS` / `FETCH_ADO_PROJECTS`:
site URL → `/rest/api/3/project/search` → project picker. Identity for "me"
comes from `/rest/api/3/myself` (`accountId`), replacing
`fetchAndPersistUserIdentity`'s display-name lookup — and `accountId` is
strictly better, because the ADO path notes that filtering on a stored display
name opens a WIQL-injection seam.

> **OAuth 2.0 3LO is deferred.** It needs a registered Atlassian app, a callback
> server, refresh-token rotation, and `cloudid` resolution via
> `accessible-resources`. That is **+5–8 d** and it is not needed for a design
> partner. Revisit when someone's security review demands it.

### P3 · ADF renderer + attachments — 3–4 d

The one genuinely net-new component. Jira Cloud returns descriptions and
comments as **Atlassian Document Format** — a JSON node tree, not HTML.
`htmlToText` does not help.

Needed: ADF → markdown/plain text (paragraph, heading, list, code block, table,
link, mention, panel), and the reverse for `addComment`, since Jira expects ADF
on the way in where ADO takes an HTML subset (`reportToHtml` in
[shipHelpers.ts](apps/vscode-extensions/src/services/agent/shipHelpers.ts)
already proves the shape of that converter).

Attachments differ structurally: ADO embeds `<img src>` in description HTML and
fetches them with the auth header. Jira references attachments from ADF
`mediaSingle` nodes and needs a separate attachment fetch. Same output
contract — `TicketImage[]` with base64 `dataUrl` for vision models — different
retrieval path.

### P4 · `get_ticket` for Jira — 2–3 d

`/rest/api/3/issue/{key}?expand=renderedFields` plus
`/rest/api/3/issue/{key}/comment`. Maps onto the existing `TicketDetail` with
no shape change once P0 lands: `issuetype.name` → `type`, `status.name` →
`state`, `parent.key` → `parentId`, `labels` → `tags`.

### P5 · Sync worker + indexing — 4–5 d

Clone of [adoWorker.ts](apps/vscode-extensions/src/workers/ado/adoWorker.ts)'s
*shape*, different query layer:

- WIQL `SELECT … WHERE [System.ChangedDate] >= @today - N` → JQL
  `project = X AND updated >= -Nd ORDER BY updated DESC`
- **Use `/rest/api/3/search/jql` with `nextPageToken`**, not the deprecated
  `/rest/api/3/search`. Existing `$top=20000` + `workitemsbatch` (200/call)
  logic does not transfer; Jira returns fields inline in the search response,
  which is *simpler*, but comments still need per-issue calls exactly as ADO does.
- Honour `Retry-After` on 429. The existing `backoffMs` is pure exponential;
  Jira Cloud's limits are tighter than ADO's and the header is authoritative.
- Index filenames `JIRA-<KEY>`, mirroring `ADO-<id>`.

Reused unchanged: the worker-thread scaffolding, resumable progress
persistence, `AdoSyncScheduler`'s scheduling, and the whole embedding pipeline.

### P6 · My Work + sprint — 2–3 d

JQL `assignee = currentUser() AND statusCategory != Done`. Ordering, caching and
the panel come from `orderWorkItems` / `MyWorkPanel` for free.

Sprint is the awkward bit: ADO parses a nested iteration path string
(`D2C\Release 1\Sprint 24`). Jira's sprint is a **custom field** whose id varies
per site, resolved through the Agile API with board discovery
(`/rest/agile/1.0/board?projectKeyOrId=` → `/board/{id}/sprint?state=active`).
`isInCurrentSprint` and `sprintLabel` become provider-supplied.

### P7 · Settings UI, message types, handler — 3–4 d

`JiraSettings.tsx` is a near-clone of `AdoSettings.tsx` with different fields
(site URL, email, API token, project picker, lookback). The 16-case
`AdoMessageHandler` is cloned to `JiraMessageHandler`; the ~40 `*_ADO_*` message
types get `*_JIRA_*` siblings.

This is the least interesting and least compressible phase — it is UI and
plumbing that the seam does not remove.

### P8 · Peripheral surfaces — 3–4 d

Ship write-back (Jira uses the bare key as its smart-commit trailer;
`conventionalCommitType` in [shipHelpers.ts](apps/vscode-extensions/src/services/agent/shipHelpers.ts)
already matches on `bug|defect` and `feature|story|epic|enhancement`, which
covers Jira's issue-type names as-is and likely needs no change), `referenceIndex`
patterns, `ticketRefs` linking, `queryClassifier` keywords (which already
mention `'jira'` — currently routing to the ADO namespace), MCP `search_jira`
tool + `dataDir` probe, Chrome extension source list.

### P9 · Evals + two-provider QA — 3–5 d

`packages/agent-evals/fixtures/retrieval/corpus/` holds six `ado-*.md` fixtures
and `queries.json`. Jira needs its own, plus a regression pass proving the ADO
path is byte-identical after P0/P1 — that is the real risk in this plan, not
the Jira code.

---

## 6. Effort summary

| Phase | Days |
|---|---|
| P0 · ID model → string | 3–4 |
| P1 · Provider seam + migrate ADO | 5–7 |
| P2 · Jira auth + discovery | 3–4 |
| P3 · ADF renderer + attachments | 3–4 |
| P4 · `get_ticket` | 2–3 |
| P5 · Sync worker + indexing | 4–5 |
| P6 · My Work + sprint | 2–3 |
| P7 · Settings UI + handler | 3–4 |
| P8 · Peripheral surfaces | 3–4 |
| P9 · Evals + two-provider QA | 3–5 |
| **Total** | **31–43 d** |

**≈ 6–9 weeks for one developer**, Jira Cloud + API token.

Add-ons: OAuth 3LO **+5–8 d**. Server/DC support **+12–17 d**.

For comparison, the clone-without-seam path is ~25–32 d — about **7 days
cheaper**, and it duplicates ~3,500 LOC permanently. After this plan, tracker #3
is P2+P4+P5+P6+P7 minus the discovery novelty: **~8–12 d**.

---

## 7. Sequencing and what unblocks what

```
P0 ──► P1 ──┬─► P2 ──► P4 ──► P6 ──┬─► P7 ──► P9
            ├─► P3 ───────────────┤
            └─► P5 ───────────────┘
                                   └─► P8
```

P0 and P1 are strictly serial and strictly first; everything after P1
parallelises across two developers if that is on offer. P3 (ADF) is the long
pole on the critical path for P4 — start it the moment P1 lands.

---

## 8. Risks

1. **The ADO regression is the real risk.** P0+P1 touch every ADO surface while
   delivering no user-visible feature. Mitigation: P9's ADO regression suite is
   written *before* P0, not after P8.
2. **Verify the Jira API surface against current docs before P5.** This design
   assumes ADF for rich text and `search/jql` token pagination as the supported
   search path. Both are stated from knowledge, not from a doc read in this
   session — confirm both, plus the current sprint custom-field story, on day 1
   of P2. If `search/jql` pagination differs, P5 moves.
3. **Per-site custom fields.** Sprint, story points and epic link are
   `customfield_NNNNN` with site-specific ids. Resolve via `/rest/api/3/field`
   at connect time and persist; never hardcode.
4. **Rate limits.** Jira Cloud will 429 a 20k-issue backfill that ADO absorbed.
   `Retry-After` handling is not optional in P5.
5. **Two trackers connected at once** is out of scope (§9) but users will ask
   for it in the first week. Keep the registry keyed by `kind` so the answer is
   a data-model change, not another refactor.

---

## 9. Out of scope (v1)

- Jira Server / Data Center (§0)
- OAuth 2.0 3LO (§P2)
- Two trackers connected simultaneously — needs namespace collision rules and
  ref disambiguation (`#123` in a repo with both) before it is safe
- Writing Jira issues (create/transition). Read + comment only, matching ADO
- Jira Service Management request types
- Confluence Cloud re-auth sharing an Atlassian token with Jira — tempting, but
  the existing Confluence auth works and this would put it at risk for no user gain
