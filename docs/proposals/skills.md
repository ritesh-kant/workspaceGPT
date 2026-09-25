# Skills — Design

**Status:** design only, not implemented
**Goal:** make small/local models reliable by replacing "figure out how to do X" with "follow this recipe for X", and shrink the per-turn prompt via progressive disclosure.

A *skill* is a markdown file containing a procedural recipe for one workflow
(e.g. "find something in the codebase", "make an edit safely", "implement a
ticket"). Only the skill(s) relevant to the current query are injected into the
prompt. Selection is **deterministic (code, not model)** because a weak model
mis-picks; the model only executes.

Two sources of skills:

1. **Built-in** — shipped with the extension, carved out of the monolithic
   instruction block in `apps/vscode-extensions/src/utils/promptTemplates.ts`.
2. **Workspace** — team-authored files in `.workspacegpt/skills/*.md`,
   analogous to how `rulesFiles.ts` loads `.workspacegpt/rules.md`. This is the
   enterprise differentiator: teams encode their own procedures once and even a
   local 7B executes them reliably.

---

## 1. Skill file format

One file per skill. YAML frontmatter + markdown body.

```markdown
---
name: edit-workflow
description: How to modify files safely (read first, small edits, verify diagnostics)
triggers:
  keywords: [edit, change, fix, rename, refactor, update the, add a, remove the, implement]
  regexes: []            # optional, for patterns keywords can't express
requires: [CODEBASE]     # only eligible when these sources/tools are active
priority: 10             # tie-breaker when multiple skills match; higher wins
maxChars: 3000           # optional per-skill cap override
---

## Editing files

1. `read_file` the target file BEFORE any edit. Never edit from memory.
2. Copy `oldString` verbatim from the read result — exact match, unique
   unless you pass `replaceAll`.
3. Prefer several small edits over one sweeping rewrite.
4. After edits are applied, call `get_diagnostics`. If it reports errors in
   files you touched, fix them before answering.
5. STOP CONDITION: if the same edit is rejected twice, do not retry it —
   summarize the rejection feedback and ask the user how to proceed.

### Example
User: "rename the `fetchData` helper to `loadData` in api.ts"
Correct sequence: `read_file(api.ts)` → `edit_file(oldString: "function fetchData(", newString: "function loadData(")`
→ `find_references(fetchData)` → edit each call site → `get_diagnostics`.
```

Frontmatter contract (all fields except `name`/`description` optional):

```ts
interface SkillMeta {
  name: string;              // kebab-case id, unique per source
  description: string;       // one line; shown in descriptions-only listing
  triggers?: {
    keywords?: string[];     // case-insensitive substring match, same style as queryClassifier
    regexes?: string[];      // compiled with 'i'
  };
  requires?: DataSource[];   // skill only eligible if all listed sources active
  priority?: number;         // default 0
  maxChars?: number;         // default MAX_PER_SKILL_CHARS
}
```

A skill with no `triggers` is never auto-selected — it is only reachable via
the explicit listing (§3, phase 2). Malformed frontmatter → skip the file and
log a warning; never break the chat turn.

### Authoring rules (enforced by convention, documented in README)

Written for a weak model, not a smart one:

- **Numbered steps in execution order.** Recipes, not principles.
- **Exact tool names and arguments** in backticks.
- **At least one worked example** of the tool-call sequence (few-shot beats
  abstract instruction on small models by a wide margin).
- **Explicit stop conditions** ("after 3 failed searches, tell the user…") —
  small models loop without them.
- **Output template** where the answer has a required shape (e.g. the ADO
  status/sprint/comments format).
- Keep under ~3k chars. If it doesn't fit, it's two skills.

---

## 2. Built-in skills (carved from `promptTemplates.ts`)

The current `contextInstruction` tool-mode blob (~1.6k tokens, sent on every
codebase turn) splits into:

| Skill | Content today (promptTemplates.ts) | Triggers |
|---|---|---|
| `find-in-codebase` | search-retry strategy: synonyms, symbol vs text vs name search, "empty ≠ absent" | where is, defined, how does, find, locate, search |
| `edit-workflow` | read-first, exact oldString, small edits, diagnostics after, rejection handling | edit, change, fix, add, remove, rename, refactor, implement |
| `run-and-verify` | run_command usage, non-interactive, fix failures before done | test, build, run, lint, compile |
| `org-grounded-task` | search_docs/search_tickets first, cite the doc | ticket-ID regex, implement <ID>, per the doc/spec |
| `git-context` | git_status/diff/log/blame usage | uncommitted, recent change, who changed, blame, history |
| `ado-answer-format` | Status/Sprint/Comments output template (currently in Response Style) | ADO source active + lookup/aggregation intent |

What stays in the base prompt permanently: identity, grounding rules,
"invoke tools immediately, never announce plans", the one-line tool inventory,
and workspace rules. Everything procedural moves into skills.

Built-in skills live in the extension bundle (`src/skills/*.md`, copied by
esbuild as assets or inlined via a codegen step — decide at implementation;
inlining avoids packaging/path issues in the `.vsix`).

---

## 3. Selection (router)

**Phase 1 — deterministic only.** A new `selectSkills()` runs beside
`classifyQuery` in `chatService.ts` (~line 298), same rule-based style:

```ts
// src/services/agent/skillRouter.ts
export function selectSkills(
  query: string,
  classification: QueryClassification,
  activeSources: DataSource[],
  skills: LoadedSkill[],          // built-in + workspace, workspace wins on name clash
): LoadedSkill[]
```

Rules:

1. Filter to skills whose `requires` ⊆ `activeSources`.
2. Score by trigger hits (keyword substring / regex, case-insensitive).
3. Sort by (score, priority), take the top **2** — an edit turn legitimately
   needs `edit-workflow` + `run-and-verify`; three recipes at once confuses a
   small model and blows the budget.
4. Zero matches on a codebase turn → inject `find-in-codebase` as the default
   (it is the safest generic recipe); zero matches on a RAG turn → inject
   nothing.

Selection is logged (analyticsService) so mis-routing is visible and trigger
lists can be tuned from real traffic.

**Phase 2 — model escape hatch (optional, later).** Append a
descriptions-only listing of the *non-selected* skills to the prompt and
expose a `load_skill(name)` tool that returns the body as a tool result.
This is the Claude-Code-style progressive disclosure; it only becomes worth
it once workspace skill libraries grow beyond what triggers cover. Weak-model
default remains deterministic pre-injection.

---

## 4. Loading

`src/services/agent/skillFiles.ts`, mirroring `rulesFiles.ts`:

```ts
export interface LoadedSkill extends SkillMeta {
  body: string;                    // markdown after frontmatter, clipped
  source: 'builtin' | 'workspace';
}

export function loadSkills(roots: NamedRoot[]): LoadedSkill[]
```

- Scan built-in set, then `<root>/.workspacegpt/skills/*.md` (first root only,
  like `loadWorkspaceRules`).
- Workspace skill with the same `name` as a built-in **replaces** it — teams
  can tune our recipes for their stack.
- Caps: `MAX_PER_SKILL_CHARS = 3_000`, `MAX_TOTAL_SKILL_CHARS = 6_000`
  (post-selection, i.e. the injected budget — same philosophy as the rules
  caps in `rulesFiles.ts`). Clip with `… (truncated)`.
- Frontmatter parsing: tiny hand-rolled key/list parser (we already avoid a
  YAML dep; format above is deliberately flat enough for that).
- Read fresh per turn like rules files — no caching/watcher in v1 (fs reads of
  a handful of small files are negligible next to the LLM call).

---

## 5. Prompt integration

`createStructuredPrompt` gains one option and loses most of its blob:

```ts
options?: {
  codebaseToolsEnabled?: boolean;
  repoOrientation?: string;
  workspaceRules?: string;
  skills?: Array<{ name: string; body: string }>;   // pre-selected, pre-clipped
}
```

Injection block, placed after project rules / before orientation:

```
**Task procedures (follow these step by step for this request):**

### edit-workflow
<body>

### run-and-verify
<body>
```

Wiring: `chatService.ts` calls `loadSkills` + `selectSkills` next to the
existing `loadWorkspaceRules` call (~line 938) and passes the result through
`modelWorker.ts` → `createStructuredPrompt` exactly like `workspaceRules`
travels today. `contextInstruction`'s tool-mode branch shrinks to the
always-true core (immediate tool invocation, grounding, tool inventory).

Expected effect on a non-edit codebase question: prompt drops from the full
blob to core + one recipe — roughly half the instruction tokens, with the
remaining half all *relevant*, which is the part that matters for a small
model.

---

## 6. Third-party skills (Agent Skills format compat)

Same rationale as `rulesFiles.ts` reading `CLAUDE.md`/`.cursorrules`: honor
what migrating users already have, zero setup.

- **Also scan `<root>/.claude/skills/*/SKILL.md`** (the open Agent Skills
  format used by Claude Code and the public anthropics/skills library).
  `name`/`description` map directly onto `SkillMeta`; unknown frontmatter
  fields are ignored.
- **Triggers:** standard skills have none (they assume a frontier model picks
  from descriptions — exactly what this design avoids for weak models).
  Imported skills are therefore not auto-selected unless the workspace
  supplies triggers via an overlay file
  `.workspacegpt/skills/triggers.json` (`{ "<skill-name>": ["kw1", "kw2"] }`).
  Otherwise they're reachable only via the phase-2 descriptions listing +
  `load_skill` tool.
- **Multi-file skills:** inject the SKILL.md body only. Bundled `references/`
  work for free — the folder is in the workspace, so the model can `read_file`
  them through existing tools. Bundled `scripts/` are NOT executed; that would
  bypass the approval-gate architecture.
- **Trust:** only repo-local skills are loaded — they pass through normal code
  review. Never fetch skills from URLs (a skill file is literal instructions
  to the model; remote fetch = prompt-injection channel).
- **Caveat:** most public skills are written long/principle-heavy for frontier
  models; caps will truncate them and even untruncated they suit remote mode
  (bigger models) far better than local mode. Local mode leans on our
  weak-model-optimized built-ins; third-party compat is primarily a
  remote-mode feature. Precedence on name clash: `.workspacegpt` >
  `.claude/skills` > builtin.

## 7. Out of scope (v1)

- Skill-invoked scripts/executables (Claude-Code-style `scripts/` dirs) —
  recipes only; execution stays behind existing tools + approval gates.
- LLM-based routing, embeddings over descriptions — trigger lists first,
  tune from analytics.
- Marketplace / remote skill installation — trust model doesn't exist yet;
  the Chrome-share system is a natural later vehicle, not v1.
- Per-model skill variants (e.g. terser bodies for <7B) — revisit if needed.

## 8. Implementation order

1. `skillFiles.ts` loader + built-in carve-out of `promptTemplates.ts`
   (behavior-neutral: initially always select the same skills the blob
   contained, verify no regression).
2. `skillRouter.ts` deterministic selection + analytics logging.
3. Workspace `.workspacegpt/skills/` support + README authoring guide.
4. `.claude/skills/*/SKILL.md` compat + `triggers.json` overlay.
5. (later) descriptions listing + `load_skill` tool.
