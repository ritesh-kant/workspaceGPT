# Permission modes: Manual / Auto / Full access

Status: phases 1-4 implemented 2026-10-04 on branch
fix/agent-runs-tasks-not-just-answers (uncommitted). Phase 5 is not built. Not yet
verified: the live dev-host run per level (section 5), which is the gate before
release. Decisions in section 6 were settled with "go with the recommendations".

Replaces the composer's Plan / Ask / Agent dial with a four-entry dial: Plan,
plus Manual / Auto / Full access modelled on ChatGPT's "How should actions be
approved?" menu.

## 1. What exists today

The dial (`apps/vscode-extensions/webview/src/App.tsx:407-452`, persisted in
`localStorage['wgpt.chatMode']`) sends two booleans per turn, `autonomous` and
`planMode`, through `modeFlags()` (6 send sites) plus 3 explicit sites (My Work
▶ at ~2106, Run plan ~2272, ticket resume ~2293).

| Dial  | Flags            | Behavior                                                                        |
|-------|------------------|---------------------------------------------------------------------------------|
| Agent | `autonomous`     | file edits auto-apply (checkpointed, audited `auto`); verification commands run without a card; other commands get a card; shell chaining/pipes refused; Confluence writes always get a card |
| Ask   | neither          | every edit, every command, every Confluence write gets a card                   |
| Plan  | `planMode`       | worker offers no write tools; host refuses writes; "Run plan" hands off to Agent |

**The defect to name:** the dial mixes two independent axes. *Plan* is "what is
this turn for" (no writes at all). *Ask/Agent* is "who approves actions". The
requested Manual / Auto / Full is purely the second axis, so Plan cannot become
one of the permission levels. Decision (Ritesh, 2026-10-04): Plan is still shown
as a fourth entry in the same dropdown; internally it stays a separate
`planMode` flag, and the dial remembers the last permission (3.3).

`autonomous` also carries *run posture*, not just permissions: the "AUTONOMOUS
RUN, NO ONE IS WATCHING" prompt block (`promptTemplates.ts:637-660`), FINAL
REPORT FORMAT, stall auto-resume (`chatService.ts:1582`), no slow-mode
(`modelWorker.ts:2470`), higher diagnostics limits, and a rewrite of the write
tools' descriptions (`modelWorker.ts:1359`). Those must not change as a side
effect of renaming the dial.

Where approval is decided today:

| Action                     | Site                                              |
|----------------------------|---------------------------------------------------|
| file edit/create/delete    | `chatService.gatedWrite` (~2247-2260)             |
| command                    | `chatService` run_command (~2005-2040), allowlist in `commandTools.ts:335-400`, hard denylist `:308` |
| Confluence write           | `gatedConfluenceWrite` (~2090), always a card     |
| browser actions            | `chatService.ts:1755-1795`, no gate (Chrome extension has its own Allow prompt) |
| card plumbing              | `agentWriteGate.ts`, `AGENT_WRITE_REVIEW`, `AgentWriteCard.tsx` |

## 2. Target

Three permission levels, one dial, labelled and described like the reference:

| Label        | Subtitle                                                        | Maps to today |
|--------------|-----------------------------------------------------------------|---------------|
| Manual       | Always ask before editing files or running commands            | Ask           |
| Auto         | Edits apply on their own; ask only for risky actions           | Agent         |
| Full access  | Run commands and make changes without asking (orange, warning icon) | new       |

| Plan         | Investigate and propose exact edits; changes nothing           | Plan          |

Plan is the first entry of the dropdown. It is a mode, not a permission level:
selecting it sends `planMode` and no write tools are offered, so the permission
is moot for that turn.

### Policy matrix

`card` = review card, `auto` = runs, `block` = refused with no override.

| Action                                                   | Manual | Auto                | Full                 |
|----------------------------------------------------------|--------|---------------------|----------------------|
| Reads (files, search, git read, Confluence/ticket read, web search) | auto | auto        | auto                 |
| Workspace edit / create / delete                         | card   | auto, checkpointed  | auto, checkpointed   |
| Verification + read-only commands (`isAutonomousSafeCommand`) | card (Allow for session) | auto | auto |
| Any other command (scripts, installs, git mutations)     | card   | card                | auto                 |
| Chained / piped / redirected commands                    | card   | refused (as today)  | auto                 |
| `COMMAND_DENYLIST` (sudo, rm -rf ~, force push, curl\|sh…)| block  | block               | block (kept, see 6.3)|
| Confluence write                                         | card   | card                | auto (see 6.2)       |
| Browser mutating actions (`act`, `eval`, `navigate`, `open_tab`) | card (phase 5) | as today | as today |

Auto and Manual rows equal today's Agent and Ask exactly. Phase 1-3 therefore
change no behavior for existing users; Full is the only new capability.

## 3. Design

### 3.1 One protocol field

Add `permission: 'manual' | 'auto' | 'full'` to `SEND_MESSAGE`. Keep `autonomous`
and `planMode` accepted: `ChatMessageHandler.ts:235` derives
`permission ?? (autonomous ? 'auto' : 'manual')`. A stale webview (see
stale-webview-history-overwrite) and any non-webview sender keep working.

`sendMessage` (`chatService.ts:897`) stores `run.permission`. `run.autonomous`
becomes a derived posture flag `permission !== 'manual'`, so every existing
`run.autonomous` consumer and the worker's `autonomous` arg are untouched
(smallest diff). The worker additionally receives `permission` for the two
places that describe approval to the model (3.4).

### 3.2 One policy function

New `src/services/agent/permissionPolicy.ts`, pure and unit-tested:

```ts
type PermissionAction =
  | { kind: 'file-write' }                       // edit | create | delete
  | { kind: 'command'; command: string }
  | { kind: 'confluence-write' }
  | { kind: 'browser-mutate' };
decide(permission, action): 'auto' | 'card' | 'refuse'
```

It wraps the existing `isAutonomousSafeCommand`, `hasAutonomousShellPlumbing`
and `assertCommandAllowed` rather than reimplementing them. `gatedWrite`,
the run_command path and `gatedConfluenceWrite` each replace their
`run.autonomous` / always-card branch with one `decide(run.permission, …)` call.
Reading `run.permission` at the moment of each action makes a live switch (5.1)
free.

Failure direction (AGENTS.md regex rule): the classifier looks at commands the
model produced, not user text, and a miss costs a card, never a capability.
Anything not positively classified safe is `card`.

### 3.3 Webview

- Replace `ChatMode` with a dial value `'plan' | 'manual' | 'auto' | 'full'`
  and `CHAT_MODE_META` with the four labels/subtitles above. Also persist
  `lastPermission` (the last non-plan value, default `auto`). `modeFlags()`
  returns `{ planMode: true }` on Plan and `{ permission }` otherwise.
- Dropdown rows need a subtitle and an icon (the screenshot's rows). The current
  `SearchableDropdown` takes label only; extend options with optional
  `subtitle`/`icon` or build a small `PermissionMenu`. Full gets the orange
  warning style.
- Persist as `wgpt.chatMode` (same key, widened values) plus
  `wgpt.lastPermission`. One-time migration of old values: `ask` to `manual`,
  `agent` to `auto`, `plan` stays `plan` with `lastPermission = auto`.
- The 3 explicit send sites: My Work ▶ and ticket resume send
  `max(current, 'auto')` (today they force `autonomous`; do not demote a user
  who is on Full). Run plan switches the dial to `lastPermission` floored at `auto`
  (today it forces Agent, and its tooltip says edits apply on their own) and
  sends that permission with `executePlan`. The Full confirmation (6.4) applies
  only when the user picks Full themselves, never on this handoff.
- Chat assistant mode still sends no dial (no tools to govern).

### 3.4 Full access needs prompt and worker changes (easy to miss)

Several strings tell the model how approval works and are false under Full:

- `promptTemplates.ts:~650`: "any other command ... shows the user an approval
  card first", and the "refuses pipes, redirects and chaining" wording.
- `promptTemplates.ts:105`: "each [command] needs the user's approval, so ask
  ONE question per command ... an autonomous run refuses chains".
- `commandTools.describeAutonomousRefusal` is never reached under Full.

Pass `permission` into `buildSystemPrompt` options and branch those sentences.
`modelWorker.ts:1359` (tool-description rewrite) stays keyed on posture.

### 3.5 Audit, analytics, local models

- `AgentAuditEntry.decision` (`commandTools.ts:577`): add `'auto-full'` so a
  Full-access action is distinguishable in `agent-actions.jsonl`.
- Analytics: add a `permission` property to the existing chat-turn event
  (no content), alongside the dashboard split by `surface`.
- `chatService.ts:989` downgrades `autonomous` for Ollama with a notice. Apply
  the same to `auto` and `full` (to `manual`), same notice.
- Remote mode, Worker API, MCP, desktop sidecar: no references to
  `autonomous`/`planMode` found; permission is entirely host-side. No
  `isDesktopHost()` gating needed.

## 4. Phases (each shippable alone)

1. **Policy module + tests, no wiring.** `permissionPolicy.ts` and a
   `permissionPolicy` section in `packages/agent-evals` unit tests covering the
   matrix, including chained commands, denylist under all three levels, and
   "unknown command = card".
2. **Host wiring.** Protocol field + back-compat derivation, `run.permission`,
   gates call `decide`. Manual/Auto must be byte-for-byte today's Ask/Agent:
   run `units`, `agent-smoke` (Auto), and confirm Ask-style cards in a dev host.
3. **Webview.** Four-entry dropdown, labels, migration, `lastPermission`, send sites.
   Check with `webview/tools/preview.mjs` (mock host) in light and dark themes.
4. **Full access.** `decide` lifts command and Confluence cards; prompt
   variants (3.4); first-use confirmation; orange chip; audit `auto-full`.
5. **Optional.** 5.1 live switch via a `SET_PERMISSION` message updating
   `run.permission` (posture, prompt and tool descriptions stay fixed for the
   turn; a card already pending stays until decided). 5.2 Manual gates browser
   mutations. 5.3 default-permission setting in Settings.

## 5. Verification

- Unit: the policy matrix; protocol derivation (`autonomous:true` gives `auto`).
- Live dev host, per level, one prompt each: edit a file; "run the tests"; "run
  `./scripts/x.sh`"; a chained command; "update this Confluence page". Record
  card / no card against the matrix. Live runs are the part that has bitten
  every prior change here (see plan-mode-enforcement), so they are the gate.
- Prompt contract: under Full the model must not claim a card will appear, and
  under Manual/Auto the prompt text must be unchanged from today.
- Regression: `pnpm --filter @workspace-gpt/agent-evals units`, `pnpm build`,
  `pnpm check-types`.

## 6. Decisions (all taken as recommended, 2026-10-04)

1. **Plan: decided.** Kept, as a fourth dropdown entry beside Manual / Auto /
   Full access (see 3.3 for how it stays separate internally).
2. **Confluence under Full.** `gatedConfluenceWrite` documents a deliberate rule:
   unreviewed edits to shared org docs never skip review. Recommend lifting it
   only in Full (Confluence page history is the undo, and "Full access" that
   still prompts is surprising). Alternative: Confluence stays a card in every
   level, and Full says so in its subtitle.
3. **Denylist under Full.** Recommend keeping the hard blocks (sudo,
   `rm -rf ~`, force push, `curl | sh`). It is a regex list, not a sandbox, so
   the subtitle must not promise protection. Unlike the reference, we do not
   offer "any file on your computer": writes stay inside open workspace roots.
4. **Persistence.** Full does not survive a reload (stored as Auto) and every
   switch to it goes through an inline confirmation strip above the composer
   (VS Code webviews block `window.confirm`). Prompt-injected web
   or ticket text is the realistic way Full goes wrong.
5. **Manual posture.** Manual keeps today's Ask posture (non-autonomous prompt)
   for now. Giving Manual the agent posture (verify loop, final report, stall
   resume) is a separate change with its own eval run.

## 7. Files touched (expected)

`webview/src/App.tsx`, `webview/src/components/SearchableDropdown` (+ css),
`webview/src/components/ChatMessage.tsx` (Run plan copy), `webview/src/types.ts`
/ `constants.ts` (message shape), `src/handlers/ChatMessageHandler.ts`,
`src/services/chatService.ts`, `src/services/agent/permissionPolicy.ts` (new),
`src/services/agent/commandTools.ts` (audit type), `src/utils/promptTemplates.ts`,
`src/workers/model/modelWorker.ts` (permission arg only),
`packages/agent-evals/src/…/unit-tests.mjs`, `docs/architecture.md`.
