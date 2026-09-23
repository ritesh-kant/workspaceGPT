import { EmbeddingSearchResult } from 'src/types/types';
import { HARNESS_LIMIT_NOUN, LimitKind } from '../workers/model/resumeHygiene';

/** The turn-scoped extras a user message can carry, shared by both prompt builders below. */
interface TurnExtras {
  textAttachments?: { name: string; content: string }[];
  imageAttachmentNames?: string[];
  mentionedFiles?: { name: string; content: string }[];
}

/**
 * Files the user attached to THIS message. Text files are inlined verbatim;
 * images travel separately as multimodal parts, so here they only get named
 * so the model knows what "the attached image" refers to.
 */
function buildAttachmentsBlock(options?: TurnExtras): string {
  const sections: string[] = [];
  for (const att of options?.textAttachments ?? []) {
    sections.push(`File: ${att.name}\n\`\`\`\n${att.content}\n\`\`\``);
  }
  if (options?.imageAttachmentNames?.length) {
    sections.push(`Attached image(s), provided alongside this message: ${options.imageAttachmentNames.join(', ')}`);
  }
  return sections.length
    ? `**User-attached files (treat as part of the question — you may use their content directly):**\n${sections.join('\n\n')}\n\n`
    : '';
}

/**
 * Files/folders the user pointed at with "@" in this message. Already read
 * from disk, so the model must not re-fetch them — but they are a starting
 * point, not the whole answer: it may still need to explore around them.
 */
function buildMentionsBlock(options?: TurnExtras): string {
  if (!options?.mentionedFiles?.length) return '';
  return (
    `**Files the user referenced with @ (already read for you — do NOT call read_file on these again unless you need a different line range). Lines are numbered as \`12→code\`: cite those numbers, and copy code WITHOUT the prefix:**\n` +
    options.mentionedFiles.map((m) => `${m.name}\n\`\`\`\n${m.content}\n\`\`\``).join('\n\n') +
    `\n\nThe user explicitly pointed at these — center your answer on them.\n\n`
  );
}

/**
 * The ticket a turn is grounded on — fetched live from Azure DevOps by the
 * host BEFORE the model runs, whenever the user's message names a work item
 * (see detectTicketId). A trimmed view of adoWorkItemService's TicketDetail:
 * images travel separately as multimodal parts, and raw HTML is already
 * converted to text.
 */
export interface TicketPromptContext {
  id: string;
  title: string;
  type: string;
  state: string;
  url: string;
  assignedTo?: string;
  sprint?: string;
  description?: string;
  acceptanceCriteria?: string;
  parentId?: string;
  comments?: { author: string; date?: string; text: string }[];
}

/**
 * Is this work item a piece of RESEARCH rather than a change to make?
 *
 * Read off the work-item TYPE — a structured field ADO already gives us and
 * buildTicketBlock already prints — never off the user's phrasing. Ticket
 * #1536998 is the case this exists for: a Spike, correctly labelled "Spike" in
 * its own header line, was handed a prompt block ending "an investigation
 * report ... is NOT a valid ending", so the run edited four files and stamped
 * the result shippable while the spike's three open questions and its "High
 * level estimation" deliverable went unanswered.
 *
 * Types, not keywords in prose: these are the values teams actually put in the
 * type field across ADO/Jira process templates.
 */
const RESEARCH_WORK_ITEM_TYPES = new Set([
  'spike',
  'research',
  'investigation',
  'analysis',
  'discovery',
  'poc',
  'proof of concept',
]);

export function isResearchWorkItem(type?: string): boolean {
  return RESEARCH_WORK_ITEM_TYPES.has(String(type ?? '').trim().toLowerCase());
}

const TICKET_DESCRIPTION_MAX_CHARS = 4_000;
const TICKET_AC_MAX_CHARS = 2_000;
const TICKET_COMMENTS_SHOWN = 3;
const TICKET_COMMENT_MAX_CHARS = 300;

const clip = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) + '… (truncated)' : text;

/**
 * The operating norms for every codebase turn — how to work, not how to
 * phrase an answer.
 *
 * Exists because the harness had been regulating the OPPOSITE end of the run:
 * ~15 phrase gates in modelWorker plus pages of prohibitions here, all about
 * the final answer, and nothing at all about when to stop reading and start
 * editing. A comparison run on ticket #1534774 made the cost concrete — the
 * model named the exact root cause at tool call 50 of a 33-turn cap, kept
 * reading for another 24 calls, hit the cap and delivered "Blocked". Nothing
 * in its prompt told it that a named root cause is the signal to commit; one
 * sentence in the autonomous block told it that blocking was a success.
 *
 * Every bullet here is self-gating, so ONE block serves a plain question, a
 * fix, a ticket run and a follow-up alike (only plan mode opts out — writing
 * is out of scope there by contract). Keep it short: this is the part of the
 * prompt that has to survive being read on turn 30 of a long transcript.
 */
export const HOW_TO_WORK = `## HOW TO WORK
- **Investigate until you can state the answer — for a bug, the root cause — in one sentence with a \`file:line\`. Then stop investigating.** Several "plausible causes" means you are not there yet; more reads after you are there just burn the budget you need for the fix.
- **When the task is to change something, the turn after you can name the root cause your next tool call is an EDIT, not another read.** If you find yourself writing "now I understand what the fix is", make it.
- **Change as little as the fix allows.** The right diff is the smallest one that corrects the reported behavior: prefer adding lines over rewriting them, open a file only because the fix needs it, and leave working code — naming, structure, unrelated call sites — exactly as you found it. Refactoring, tidying and extra helpers "while you are in there" are out of scope unless the task asks for them.
- **A question a competent engineer would settle with a default is yours to settle.** Take the default, implement it, and record it in one line under Assumptions. Which file a shared fix lands in, which existing signal to reuse, naming — implementation choices, never reasons to stop.
- **"Blocked" / "cannot determine" is for exactly one case:** the task demands behavior no default could satisfy, and you can QUOTE the words that conflict. If you cannot quote them, you are not blocked — keep working. Anything a tool could answer (which file owns a behavior, what a mapper actually supplies, how a value flows on first render) is investigation, not a blocker.
- **Finish the whole task.** Changed files means: edit → \`get_diagnostics\` → \`run_checks\` (lint, typecheck, test) on every file you touched → report. Fix what fails. If a check could not run, say so in the report instead of implying it passed.
- **Never describe an edit you did not make.** The user sees the real diff, so a report of changes that are not on disk is the one unrecoverable failure — worse than an unfinished task. If you decided against a change, say that plainly.
- **A question that spans several files you have not read is a job to DELEGATE, not to read your way through.** Call \`explore\` with the question: it searches and reads on its own budget and hands back cited findings, so those file contents never fill up this conversation. Then open just the ranges it cites. Read files yourself when you already know which one you need.
- Reuse what you already have: do not re-read a file whose contents are already above, and do not re-run a search you already ran.
`;

/**
 * The shape of every autonomous / ticket run's final answer. The webview
 * renders it as a card (ChatMessage.tsx: status banner from the H2, verdict
 * badges from the table, clickable file pills from backticked paths), so the
 * headings here are a contract, not a style preference — and the "## Blocked"
 * / "## No change needed" variants must stay recognizable to
 * TICKET_TERMINAL_RE (answerGates.ts), which tolerates the emoji prefix.
 *
 * Why so prescriptive: the first live reports were process diaries — "this
 * turn re-ran the same verifications", harness cache caveats, "uncommitted on
 * main and visible as a diff" — none of which the user can act on. The user
 * needs five things: did it work (and if not, exactly why not), what was
 * actually wrong, is each criterion met, what changed, how was it verified.
 * Everything else is noise in a 350px panel.
 *
 * "Root cause" and the mandatory "why" on Partially done were added after a
 * live report read "Partially done — fix applied to two files; run_checks not
 * run yet": it named neither what had been wrong nor why checks were skipped
 * (the step cap), because the format had no root-cause slot and its
 * "never say step limit" rule collided with the forced-report prompt's "say
 * step limit reached" — so the model dropped the reason altogether.
 */
export const FINAL_REPORT_FORMAT = `## FINAL REPORT FORMAT
The user reads ONLY your final answer, in a narrow side panel that renders this exact structure as a card. The status heading is the FIRST LINE of your answer — not one sentence before it, not "now let me write the report". Then only the sections below, in this order. No other headings, no sign-off.

## ✅ Done — <what now works, in the ticket's own terms, ≤ 25 words>
Use exactly one of these status headings instead when it applies:
  ## ⚠️ Partially done — <what is left> · <WHY it is left: the exact obstacle>
      The "why" is mandatory and concrete: "step limit reached before run_checks", "jest fails to start: Cannot find module X", "needs the design's empty-state copy". "not run yet" or "pending" is not a reason — the user cannot act on it.
  ## 🚫 Blocked — <the ONE product/behavior decision the ticket is missing>
  ## ✅ No change needed — <why the code already satisfies the ticket>

### Acceptance criteria
| Criterion | Verdict | Evidence |
|---|---|---|
| <criterion paraphrased in ≤ 12 words> | ✅ Met · ❌ Not met · ⚠️ Could not verify (pick one) | <ONE item — a \`path/from/repo/root.ts:L120-L130\`, a test count, or a diagnostic count; never a sentence> |

### Root cause  (required for a bug/defect; omit for a pure feature or chore)
<1–2 sentences: the MECHANISM that produced the reported behavior — which value/branch/timing was wrong and why the symptom followed — anchored to \`path/from/repo/root.ts:L18-L32\`. Not a restatement of the symptom, not a description of the fix. If you did NOT establish the mechanism, write "Not established — <what you observed instead>"; never invent one to fill the slot.>

### Changes
- \`path/from/repo/root.ts\` — what changed and why, one line each (omit this section when nothing changed)

### Verification
- ✅ \`<exact command run>\` — <one-line result, e.g. 5 passed>
- ✅ Diagnostics — 0 problems
  (use ❌ for anything that failed, and say in the same line what you did about it)

### Notes  (optional, at most 3 bullets)
- Assumption: <a default you acted on>
- Out of scope: <related work you deliberately did not do>

Verdict honesty: a criterion about BEHAVIOR is ✅ Met only when a test or command you actually ran proves it — if the relevant test could not be run, that criterion is ⚠️ Could not verify (reading the code is not verification; say so in the evidence cell). A criterion about code SHAPE (a test was added, a call was removed) may cite \`file:line\` as proof.
Rules: cite files in backticks as \`path/from/repo/root.ts:L12-L20\` — they become clickable. Write a work-item reference as a bare \`#<id>\` (e.g. #1516750) OUTSIDE backticks — it becomes a link to the ticket. Never narrate the process in the body: no "this turn" / "previous turn" / "cache artifact" / "I re-ran", no restating the ticket, no "uncommitted on main" or "visible as a diff" boilerplate (the panel already shows changed files and their diffs). Everything outside the table stays under ~180 words. Never invent a criterion the ticket does not contain. The ONE place a harness limit belongs is the Partially-done heading's "why" ("step limit reached before run_checks") — never in the body, never as a Blocked reason.
`;

/**
 * The shape of a SPIKE's final answer.
 *
 * A spike is finished when the questions it was raised to settle are settled —
 * so the deliverable is findings, an answer per open question, the change set
 * it recommends (as file:line, not as a diff), and the estimate the ticket
 * asks for. FINAL_REPORT_FORMAT cannot carry that: its criteria table demands
 * per-criterion verdicts against code that, on a spike, deliberately does not
 * change yet, and its instructions call an investigation report an invalid
 * ending. Same H2-banner-then-sections contract, so the webview card renders
 * it unchanged.
 */
export const SPIKE_REPORT_FORMAT = `## SPIKE REPORT FORMAT
The user reads ONLY your final answer, in a narrow side panel that renders this exact structure as a card. The status heading is the FIRST LINE — no preamble. Then only the sections below, in this order.

## 🔍 Spike complete — <the answer the spike was raised to get, in ≤ 25 words>
Use exactly one of these instead when it applies:
  ## ⚠️ Spike partially answered — <which question is still open> · <WHY: the exact obstacle>
  ## 🚫 Blocked — <the ONE decision or access the spike cannot proceed without>

### Findings
- <one fact per bullet, each anchored to \`path/from/repo/root.ts:L12-L20\`, a doc, or a ticket — what IS true in the code today, not what should change>

### Open questions
| Question (from the ticket) | Answer | Evidence |
|---|---|---|
| <the ticket's question, ≤ 12 words> | <the answer, or "Unresolved — <what it needs>"> | <ONE item: file:line, doc link, or test output> |
Every question the ticket asks gets a row. An unresolved one says what would resolve it — never leave it out, and never invent a question the ticket does not ask.

### Recommended change
- \`path/from/repo/root.ts:L12\` — what to change and why, one line each (the change set, NOT applied unless you were asked to apply it)
- <or "None — <why the current code already satisfies the goal>">

### Estimate
<Size the recommended change: the files/flows touched and what dominates the effort. One or two lines. If the ticket asks for a high-level estimate, this section is mandatory.>

### Verification
- ✅ \`<exact command or search run>\` — <one-line result>
  (use ⚠️ for anything you could NOT verify, and say what it would take)

### Notes  (optional, at most 3 bullets)
- Assumption: <a default you acted on>
- Out of scope: <related work you deliberately did not do>

Rules: cite files in backticks as \`path/from/repo/root.ts:L12-L20\` — they become clickable. Write a work-item reference as a bare \`#<id>\` OUTSIDE backticks. No process narration ("this turn", "I re-ran"), no restating the ticket. Everything outside the tables stays under ~200 words.
`;

/**
 * The pre-fetched ticket as a prompt section. This is the run's definition of
 * done: the model is told to key its final answer to the acceptance criteria,
 * which is what makes an autonomous run's report auditable (met / not met /
 * could not verify, per criterion).
 */
/**
 * Every link the ticket itself carries, hoisted out of its prose.
 *
 * The design doc for #1536998 was linked in the ticket's only comment and the
 * prompt did include that comment — the run still never opened it, because a
 * URL sitting in a sentence is not an instruction to fetch anything, and the
 * synced index it searched instead predated the page by a week. Listing the
 * links as their own section, each next to the tool that retrieves it, turns
 * "there is a doc behind this ticket" from something the model has to notice
 * into something it has to decline.
 */
const URL_RE = /https?:\/\/[^\s)\]<>"']+/g;
const TICKET_LINKS_SHOWN = 6;

function isConfluenceUrl(url: string): boolean {
  return /atlassian\.net\/wiki\//i.test(url) || /confluence/i.test(url);
}

function buildTicketLinks(t: TicketPromptContext): string {
  const haystack = [t.description ?? '', t.acceptanceCriteria ?? '', ...(t.comments ?? []).map((c) => c.text)].join('\n');
  const urls = [...new Set(haystack.match(URL_RE) ?? [])]
    // The ticket's own URL is already in the header and is not a reference.
    .filter((u) => !u.includes(`/${t.id}`))
    .slice(0, TICKET_LINKS_SHOWN);
  if (!urls.length) return '';
  return (
    `\n**Links in this ticket — open them, do not answer around them:**\n` +
    urls
      .map((u) =>
        isConfluenceUrl(u)
          ? `- ${u} → call \`get_confluence_page\` with this URL (live; the synced docs index may predate the page)`
          : `- ${u} → external reference; use \`search_web\` if you need what it says`
      )
      .join('\n') +
    `\nIf one of these cannot be retrieved, say so in your report — do not silently substitute a search result for the document the ticket points at.`
  );
}

function buildTicketBlock(
  t?: TicketPromptContext,
  implementMandate = false,
  lookupOnly = false,
): string {
  if (!t) return '';
  const lines: string[] = [
    `## Ticket #${t.id}: ${t.title}`,
    `(Fetched live from Azure DevOps just before this turn — this IS the current ticket; do not call get_ticket for #${t.id} again.)`,
    `- ${t.type} · State: ${t.state}${t.assignedTo ? ` · Assigned to: ${t.assignedTo}` : ''}${t.sprint ? ` · Sprint: ${t.sprint}` : ''}`,
    `- URL: ${t.url}${t.parentId ? ` · Parent: #${t.parentId}` : ''}`,
  ];
  if (lookupOnly) {
    if (t.description) {
      lines.push(`\n**Description:**\n${clip(t.description, 1_000)}`);
    }
    return lines.join('\n');
  }
  if (t.description) {
    lines.push(`\n**Description:**\n${clip(t.description, TICKET_DESCRIPTION_MAX_CHARS)}`);
  }
  if (t.acceptanceCriteria) {
    lines.push(`\n**Acceptance criteria:**\n${clip(t.acceptanceCriteria, TICKET_AC_MAX_CHARS)}`);
  }
  const comments = (t.comments ?? []).slice(0, TICKET_COMMENTS_SHOWN);
  if (comments.length) {
    lines.push(
      `\n**Recent comments:**\n` +
        comments
          .map((c) => `- ${c.author}${c.date ? ` (${c.date.slice(0, 10)})` : ''}: ${clip(c.text, TICKET_COMMENT_MAX_CHARS)}`)
          .join('\n')
    );
  }
  const links = buildTicketLinks(t);
  if (links) lines.push(links);
  // A spike's definition of done is an ANSWER, not a diff. The implement
  // paragraph below would otherwise tell this run that the very deliverable
  // the ticket asks for is "NOT a valid ending" (#1536998).
  if (isResearchWorkItem(t.type)) {
    lines.push(
      `\nThis work item is a **${t.type}** — research, not a change to ship. Its definition of done is the ANSWER: every question the description asks, settled with evidence, plus the change set you recommend (as \`file:line\`) and the estimate the ticket asks for. ` +
        `Investigate the real code and docs as thoroughly as you would for an implementation — a spike answered from assumption is worthless — but reaching a well-evidenced recommendation IS the valid ending here, and leaving the tree untouched is not a stall. ` +
        `Do NOT edit files to "prove" the recommendation` +
        (implementMandate
          ? `, EXCEPT that the user's instruction for this run also asks you to implement: do both — answer the spike's questions first, then apply the change and verify it, and add a "### Changes" and per-criterion "### Acceptance criteria" section after the spike sections.`
          : `; if the change turns out to be trivial, say so in "Recommended change" and let the user ask for it.`) +
        ` If the ticket links a design doc (SDR, RFC, Confluence page), READ IT before concluding — fetch it by URL or id rather than relying on a search index that may predate it, and if you could not retrieve it, say so in the report instead of answering around it. ` +
        `Your final answer MUST follow the SPIKE REPORT FORMAT given below. Never invent a question the ticket does not ask.`
    );
    return lines.join('\n') + '\n' + SPIKE_REPORT_FORMAT + (implementMandate ? '\n' + FINAL_REPORT_FORMAT : '');
  }
  lines.push(
    `\nTreat the acceptance criteria (or, absent explicit ones, the description's expected behavior) as the definition of done. ` +
      `Your final answer MUST follow the FINAL REPORT FORMAT given below: one status heading, then an **"Acceptance criteria"** table with a verdict per criterion — met, not met, or could not verify — and ONE item of evidence each (file:line, diagnostic, or test output). ` +
      `Those three are the ONLY verdicts: "met after the fix is applied" is not a verdict, it is an unapplied fix — apply it first, then verify against the changed code. ` +
      `Never invent a criterion that is not in the ticket. ` +
      `When the task is to implement, the run has exactly THREE valid endings: (1) you applied the fix with your edit tools and report per-criterion verdicts; (2) the code already satisfies the acceptance criteria — end with a **"## No change needed"** section citing file:line evidence; (3) the ticket demands behavior no default could satisfy — end with a **"## Blocked"** section QUOTING the words that conflict (HOW TO WORK above defines that bar; a missing decision you could settle with a default is not it). ` +
      `An investigation report, hypothesis, or proposed fix without edits is NOT a valid ending, and neither is a finished diff presented in prose with a request to confirm it — every write is already shown to the user as a diff they approve or reject. ` +
      `Record every default you acted on under an **"Assumptions"** line: an assumption describing a fix you did NOT implement is the same failure as asking permission.`
  );
  return lines.join('\n') + '\n' + FINAL_REPORT_FORMAT;
}

export function createStructuredPrompt(
  searchResults: EmbeddingSearchResult[],
  prompt: string,
  chatHistory: string = '',
  currentUserName?: string,
  currentSprint?: { name: string; iterationPath: string; startDate: string; endDate: string } | null,
  options?: { codebaseToolsEnabled?: boolean; toolAvailability?: { codebase: boolean; confluence: boolean; tickets: boolean }; ticketTrackerLabel?: string; harnessProfile?: 'small-model' | 'strong-model'; repoOrientation?: string; promptProfile?: 'full' | 'narrow'; workspaceRules?: string; textAttachments?: { name: string; content: string }[]; imageAttachmentNames?: string[]; mentionedFiles?: { name: string; content: string }[]; executeMandate?: boolean; ticketContext?: TicketPromptContext; ticketLookupOnly?: boolean; implementMandate?: boolean; writeExpected?: boolean; autonomous?: boolean; planMode?: boolean; chatOnly?: boolean }
): string {
  const greetingRegex =
    /^\s*(hello|hi|hey|hey there|hi there|good (morning|afternoon|evening|night))\s*$/i;
  const isGreeting = greetingRegex.test(prompt.trim());

  const formattedContext =
    !isGreeting && searchResults.length > 0
      ? searchResults
          .map((result) => `[Source: ${result.data.source}]\n${result.text}`)
          .join('\n\n')
      : '';

  // Extract and deduplicate sources
  const sourceLinks =
    !isGreeting && searchResults.length > 0
      ? searchResults.map((result) => result.data).filter((src) => !!src)
      : [];

  const sourcesMarkdown = sourceLinks.length
    ? `**Provided Sources (use ONLY these links):**\n${sourceLinks.map((src) => `[${src.fileName}](${src.source})`).join('\n')}\n`
    : '';

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const toolsEnabled = !!options?.codebaseToolsEnabled;
  // Chat mode: the user asked for a plain conversation, so this turn has no
  // tools and nothing was retrieved. It is NOT the same state as a Work-mode
  // turn that happens to have nothing connected — that user should be told
  // their sources are unindexed, this one should be told to switch modes —
  // so it is carried as its own fact rather than inferred from empty inputs.
  const chatOnly = !!options?.chatOnly;

  // Only describe the org tools the worker will actually offer (see
  // scopeToolDefs): telling the model about `get_ticket` when its tool list
  // has no `get_ticket` invites a failed call and costs prompt tokens on every
  // turn of the run. An absent availability (older host) keeps the full text.
  const avail = options?.toolAvailability;
  const ticketTools = !avail || avail.tickets;
  const docTools = !avail || avail.confluence;
  // Whichever tracker is actually connected (Azure DevOps, Jira, …) — an
  // absent label (older host, or no availability object at all) keeps the
  // original ADO-only wording, since that is what a pre-provider-seam host
  // always meant.
  const trackerLabel = options?.ticketTrackerLabel ?? 'Azure DevOps';
  const orgKnowledgeBlock =
    ticketTools || docTools
      ? 'Org knowledge — this is what you have that a repo-only assistant does not; use it. ' +
        (ticketTools
          ? `\`get_ticket\` reads ONE ${trackerLabel} ticket by ID, live and complete: whenever the user names a ticket ("1234", "TKT-1234", "#1234"), call it FIRST, before touching code. \`search_tickets\` finds tickets by description instead, over a local synced index that may be stale — use it only when you have no ID. `
          : '') +
        (docTools ? '`search_docs` searches Confluence design docs/architecture/runbooks. ' : '') +
        (ticketTools
          ? 'When implementing a ticket: `get_ticket` for the acceptance criteria → ' +
            (docTools ? '`search_docs` for the design doc behind it → ' : '') +
            'then explore the code. Treat the acceptance criteria as the definition of done and check your work against each one. Cite the ticket' +
            (docTools ? ' and the doc' : '') +
            ' when they drive a decision, and NEVER invent an ID or a requirement that was not in what you actually read. '
          : '')
      : '';
  // Prompt weight is per-TURN cost: this text is re-sent on every request of a
  // 30-turn run. The clauses gated on this flag exist to counter specific
  // 14B-class failure modes — a narrated tool plan instead of a call, giving
  // up after one search wording, claiming the write tools were withheld — and
  // each is paired with the phrase gate that catches the same failure in the
  // answer (see resolveHarnessProfile in answerGates). Turning both off
  // together is the point: a gate with no matching instruction would punish a
  // model that was never told.
  const smallModelHarness = options?.harnessProfile !== 'strong-model';

  // Two very different grounding regimes: RAG turns must stay inside the
  // pre-fetched Context, but tool turns have NO pre-fetched context — telling
  // the model "only use the Context below" there hands it a ready-made refusal
  // and directly contradicts the explore-with-tools instructions.
  // Third grounding regime: a TOOL turn that also carries pre-fetched org
  // context. Until 2026-09-05 these were mutually exclusive — retrieval turns
  // had no tools, tool turns had no retrieval — and "only the Context below"
  // vs "only tool results from this turn" were the only two stories the prompt
  // could tell. Now retrieval rides into tool turns, so the model needs the
  // merged rule: answer from what was fetched when it suffices, verify in the
  // workspace when it does not, and never lose the ability to do either.
  const withContext = toolsEnabled && !!formattedContext;

  const groundingRules = chatOnly
    ? `## CHAT MODE
Answer general questions directly. You cannot inspect this workspace, internal documents, or tickets; never guess their facts. Only when the answer depends on them, say that Work mode can look them up.`
    : withContext
    ? `## CRITICAL GROUNDING RULES (MUST FOLLOW):
  1. **Ground every claim in the Context below or in a tool result from THIS turn.** The Context was retrieved from Confluence/Azure DevOps before you started — treat it as evidence you already hold.
  2. **If the Context answers the question, answer from it directly and cite its Provided Sources.** Do not re-run search_docs/search_tickets for what is already in front of you.
  3. **If the Context is insufficient, or the request asks for a change to the code, use your tools.** Do not conclude something is absent until you have genuinely searched — several keyword variations, symbol search, and file-name search.
  4. **NEVER invent links, ticket numbers, IDs, or file paths.** Cite only Provided Sources, tool results from this turn, and files you actually read.`
    : toolsEnabled
    ? `## CRITICAL GROUNDING RULES (MUST FOLLOW):
  1. **Ground every claim in a tool result from THIS turn.** Only state file paths, symbols, and behavior you actually observed via your tools — never guess or reconstruct them from memory.
  2. **Do not conclude something is absent until you have genuinely searched for it** — content search with several keyword variations, symbol search, and file-name search. An empty search result means "not found by that query", not "does not exist".
  3. **NEVER invent links, ticket numbers, or IDs.** Only cite tickets/docs returned by search_tickets/search_docs in this turn.`
    : `## CRITICAL GROUNDING RULES (MUST FOLLOW):
  1. **ONLY use information explicitly present in the provided Context below.** Do NOT generate, infer, or fabricate any ticket IDs, URLs, status values, sprint names, or other factual details.
  2. **If the context does not contain enough information to answer the question, say so clearly.** For example: "I don't have information about this in the currently indexed data."
  3. **NEVER invent links or URLs.** Only use the exact source links provided in the "Provided Sources" section below. If no sources are provided, do not include a Sources section.
  4. **Do NOT make up ticket numbers**, work item IDs, or reference codes. If the user asks about a ticket not present in the context, say it wasn't found.
  5. **Do NOT combine information from different tickets** to create a fabricated answer. Each piece of information must come from a single, identifiable source in the context.`;

  const personalityPrompt = `
  You are **WorkspaceGPT**, a local, privacy-first AI assistant for developers, designed to run entirely within Visual Studio Code. ${chatOnly ? 'The user has put you in **Chat mode**: an ordinary conversation, with their docs, tickets and codebase deliberately left out of reach for this turn.' : toolsEnabled ? 'You explore the open workspace live with tools to provide intelligent, verified answers about the codebase.' : "You use Retrieval-Augmented Generation (RAG) to provide intelligent, context-aware responses based on the user's codebase and integrated documentation."}

  ${groundingRules}

  ## Response Style:
  - Sound like a senior engineer — helpful, concise, and confident.
  - Always format responses in Markdown for readability.
  - Avoid small talk. Be to-the-point and helpful.
${chatOnly ? '' : `  - **ADO Tickets**: When answering about Azure DevOps tickets, ALWAYS explicitly mention its Status, assigned Sprint (Iteration), and any notable callouts from its Comments/Description — but ONLY if this information exists in the provided context.`}
  `;

  // Everything above this point is identical for every question asked from
  // this workspace in this mode — which is exactly what a provider's prompt
  // cache keys on, so the date lives DOWN here with the other per-turn facts
  // rather than at the top where it would expire the whole prefix once a day.
  const todayBlock = `  **Today's date: ${today}.** Use this to interpret relative time references like "current sprint", "this week", "recent", or "upcoming" based on sprint dates visible in the provided context.\n`;

  // Inject user identity and current sprint if available
  const adoContextLines: string[] = [];
  if (currentUserName) {
    adoContextLines.push(`  - **Current ADO User:** ${currentUserName}. When the user refers to "my tickets", "my work", "assigned to me", or uses "I"/"me" in the context of Azure DevOps, they are referring to this person.`);
  }
  if (currentSprint) {
    const datePart = currentSprint.startDate && currentSprint.endDate
      ? ` (${new Date(currentSprint.startDate).toLocaleDateString()} – ${new Date(currentSprint.endDate).toLocaleDateString()}, path: ${currentSprint.iterationPath})`
      : ` (path: ${currentSprint.iterationPath})`;
    adoContextLines.push(`  - **Current Sprint:** ${currentSprint.name}${datePart}. When the user refers to "current sprint", "this sprint", or "active sprint", they mean this iteration.`);
  }
  const adoContextBlock = adoContextLines.length
    ? `\n  ## Current ADO Context:\n${adoContextLines.join('\n')}\n`
    : '';

  const codebaseToolsEnabled = toolsEnabled;
  const broadInvestigation = options?.promptProfile !== 'narrow';
  const writeWorkflow = !!options?.writeExpected;

  const contextInstruction = isGreeting
    ? 'The user greeted you. Respond with a warm, friendly greeting. **Do NOT use any context.**'
    : chatOnly
    ? 'Answer directly from general knowledge or material the user supplied. For workspace-, ticket-, or internal-document-specific questions, state that Chat mode cannot inspect those sources and recommend Work mode; do not guess.'
    : codebaseToolsEnabled && (broadInvestigation || writeWorkflow)
      ? (withContext
          ? 'Context from Confluence/Azure DevOps was retrieved for this question and appears under **Context** below. If it answers the question, answer from it directly and cite its Provided Sources — do not re-search for what is already there. Reach for your tools when the Context is insufficient, or when the user asks for a change to the code. '
          : 'Answer the user\'s question about this codebase. ') +
        'You have live tools to explore the open workspace; use them to find and verify facts before answering rather than guessing. Only state things about the code that you have actually confirmed via a tool call. ' +
        (smallModelHarness
          ? 'NEVER reply with a plan or an announcement of which tools you intend to use — invoke the tools immediately, in this same turn, via the function-calling mechanism. A reply like "I will use find_files to locate the file" without an actual tool invocation is a failure. Do not write JSON tool calls into your text either. '
          : '') +
        'Pick the right tool for the job: `explore` delegates a QUESTION spanning several files you have not read to a read-only investigator and returns cited findings without those files entering this conversation (use it before a multi-file survey; not for a file you already know you need); `find_symbol` for "where is X defined" when you know a symbol name (exact language-index answers, better than text search); `find_references`/`go_to_definition` to trace how a symbol is used once you\'ve located one occurrence; `search_codebase` for text/regex content search (use `outputMode: "files_with_matches"` first to cheaply survey which files matter, then read the interesting ones); `find_files` to locate files by NAME pattern; `list_directory` and `read_file` to inspect structure and content directly. You may request several independent tool calls in a single turn — they run in parallel. ' +
        (smallModelHarness
          ? 'A single search rarely settles a question — `search_codebase` only matches the literal text you pass it, so a query worded differently than the source (e.g. asking about "filters" when the doc says "criteria" or "options") can come back empty even when the answer is right there. It also cannot find a feature whose *implementation* never uses the words used to *describe* it — a design doc talking about "leads and funnel" may be implemented in a component named `LeadsView.tsx` that never contains that phrase. ' +
            'Before concluding something isn\'t in the codebase: retry `search_codebase` with different keywords (individual words, synonyms, related terms); try `find_symbol` and `find_files` with the feature/entity name; `read_file` plausibly-relevant files directly. Only say the information isn\'t there after content search, symbol search, AND name search have all failed. '
          : 'A search only matches the literal text you pass it, so vary the wording before concluding something is absent — and remember an implementation need not use the words that describe it. ') +
        'The FIRST plausible search hit is not necessarily the right one. When the question names a specific service/app/module, verify the files you cite actually belong to it — the directory or package name should match the asked-about name (asked about "product enricher" but reading files under "product-feeds" means you have the WRONG app; keep looking). In a monorepo several apps can match one keyword — run `find_files` with the asked-about name (e.g. "**/*enricher*") to enumerate the candidates and pick by name, and say so if the name is genuinely ambiguous. ' +
        'Answer the WHOLE question, not just the first fact you find. "How is X triggered/invoked/deployed/configured" questions usually have several answers at once — event subscriptions, schedules/cron, queue consumers, HTTP endpoints, manual/CLI invocations. Read the app\'s full configuration (serverless.yml, terraform/*.tf, package.json scripts) and enumerate EVERY mechanism defined there before answering. ' +
        'Answer from BOTH documentation and implementation when both exist — docs describe intent, code is the ground truth for what actually exists. ' +
        'IMPORTANT: chat history may contain earlier claims about what was or was not found in the codebase — do NOT rely on them as facts. The workspace may have changed and earlier searches may have been weaker. Re-verify with fresh tool calls any claim you are about to repeat or act on. This applies to FACTUAL claims, not to decisions the user has already agreed to: an approved plan stays approved. Re-read the specific files you are about to edit (you need their exact current text for `oldString` anyway) rather than re-running the whole investigation that produced the plan. ' +
        'You can also CHANGE the workspace when the user asks for it: `edit_file` replaces exact text in a file — read_file the file first, then copy oldString character-for-character from that output, keeping its line breaks and indentation (never collapse a multi-line function onto one line, never retype code from memory); the match must be exact and unique unless replaceAll. `create_file` makes new files, `delete_file` removes them. Every write is shown to the user as a diff for approval before it is applied; a rejection returns their feedback — adjust and try again rather than repeating the same edit. Batch every change to ONE file into a single edit_file call via its `edits` array (each entry an exact oldString/newString pair, applied in order) — one call per file, never one call per change; prefer focused replacements over a full-file rewrite. When renaming or replacing something, update EVERY reference — the definition, export/module.exports lines, imports/requires, and every call site — then prove completeness by running `search_codebase` on the OLD name and updating any match that remains. After edits are applied, call `get_diagnostics` to verify you introduced no compile/type errors, and fix any you did. Never edit files the user did not ask you to change.' +
        (smallModelHarness
          ? ' These write tools are ALWAYS in your tools array alongside the read tools on codebase turns — never claim edit_file/create_file is "unavailable" or "not exposed"; if a write call fails, report its literal error instead. '
          : ' ') +
        'For repo context: `git_status`/`git_diff` show uncommitted work, `git_log` shows recent history, `git_blame` explains who last touched a line range — all read-only. ' +
        '`run_checks` runs the tests / lint / typecheck that cover ONE FILE — it derives the package, package manager, runner, sibling test file and working directory itself, so it never picks the wrong directory or an unapproved command. After your edits, call it with kind "lint", "typecheck" and "test" for every file you changed, and FIX failures before declaring the task done — if you skip it the run runs those checks itself before accepting your answer, so the failures reach you either way. `run_command` executes an arbitrary shell command (with user approval) — use it only when run_checks reports it cannot find a runner. Keep commands non-interactive (no watch modes, no prompts). ' +
        orgKnowledgeBlock +
        '`search_web` is a live internet search — use it the moment a task names something you don\'t actually know (an unfamiliar library, API, product, or service — e.g. "add ZenMux as a provider") instead of guessing at its shape from a similar-sounding name. Also reach for it when the answer depends on something that can change after your training (current docs, pricing, version numbers, breaking changes) — the codebase and org docs cannot tell you that. Do NOT use it for anything answerable from THIS workspace or from Confluence/ADO — those are cheaper and authoritative for org-internal facts. It may be unconfigured (no API key) — if so it reports that plainly; fall back to your own knowledge and say so, don\'t stall the task on it. When you do use its results, cite the source URLs.'
    : codebaseToolsEnabled
      ? (withContext
          ? 'Use the retrieved Context when it answers the question; otherwise use your tools to verify the workspace. '
          : 'If the question needs workspace facts you have not already established in this conversation, use tools to verify them; never guess. ') +
        'If the conversation, tool results already in it, or the files attached to this message answer the question — or it is not about this workspace at all — answer directly without calling tools. ' +
        '`read_file` inspects a known file, `find_symbol` finds a known symbol, `search_codebase` finds text, and `explore` handles a question that spans several unread files. ' +
        (smallModelHarness ? 'Invoke tools directly rather than narrating a plan. ' : '') +
        'Re-check a file only when the user says it changed or you edited it since you last read it. ' +
        orgKnowledgeBlock +
        'Use `search_web` only for unfamiliar or time-sensitive external facts, and cite its URLs when used.'
      : 'Answer the user\'s question using ONLY the context provided below. If the context does not contain relevant information, clearly state that you don\'t have the data rather than guessing.';

  // The user approved a plan the previous turn proposed (see APPROVAL_RE in
  // chatService). Without an explicit revocation the model re-derives the same
  // investigation and asks for approval again — the seeded ticket prompt says
  // "propose a plan before changing anything", and nothing else ever takes that
  // back. This is the exit from plan mode.
  const executeMandateBlock =
    codebaseToolsEnabled && options?.executeMandate
      ? `## THIS TURN CARRIES OUT AN ALREADY-APPROVED PLAN
The user's reply approves the plan in your previous message. It is an instruction to DO IT NOW — not to restate it, re-justify it, or re-scope it.
- Make the actual changes with \`edit_file\`/\`create_file\`. Do NOT reply with a plan, a recap of the plan, or a prose diff.
- Do NOT ask for confirmation or permission, and do NOT end with "shall I proceed?" — you already have approval. Every write is shown to the user as a diff they approve or reject before it touches disk, so asking first protects nothing and stalls the task.
- Re-read only the files you are about to change. Do not re-run the investigation that produced the plan.
- If reading the code shows part of the plan was wrong, fix that part and say so in your final answer — but still complete every part that holds.
- Finish by reporting what you actually changed, verified with \`get_diagnostics\`.
`
      : '';

  // The operating norms (HOW_TO_WORK) ride on every codebase turn — a plain
  // question, a fix, a ticket run, a follow-up — because the failures they
  // prevent are not ticket-specific: the read-forever stall, the unearned
  // "Blocked", and the report of edits that were never made all showed up on
  // ordinary turns too. Plan mode is the one exclusion: "your next call is an
  // edit" contradicts its contract, which is to propose and not write.
  const howToWorkBlock = codebaseToolsEnabled && !options?.planMode ? `${HOW_TO_WORK}\n` : '';

  // Plan mode inverts the execute pressure: this turn's DELIVERABLE is the
  // plan, so the anti-plan gates in the worker are disarmed (see planMode in
  // modelWorker) and the model is told writing is out of scope. The user's
  // approval reply then becomes the executeMandate turn above.
  const planModeBlock =
    codebaseToolsEnabled && options?.planMode
      ? `## PLAN MODE — INVESTIGATE AND PROPOSE, DO NOT MODIFY
This turn produces a reviewable plan, not changes. Investigate with your read tools until you can name the root cause at file:line precision — a plan built on unread files is a guess, not a plan.
Then reply with: the root cause (with evidence), the exact edits you would make (file, location, before → after), how you would verify them, and any assumption you would act on.
Do NOT call edit_file/create_file/delete_file this turn. The user will approve the plan and the next turn carries it out.
`
      : '';

  // An autonomous run has no one at the keyboard: writes apply without a
  // review card (checkpointed and auditable afterwards), so any turn spent
  // asking permission is a turn wasted — and a run that stalls on a question
  // simply dies. The block replaces the human-in-the-loop framing, not the
  // grounding rules: hallucinated edits are WORSE unattended.
  const autonomousBlock =
    codebaseToolsEnabled && options?.autonomous
      ? `## AUTONOMOUS RUN — NO ONE IS WATCHING
This run was started with a single click and nobody will answer questions mid-task.
- NEVER ask for permission, confirmation, or feedback. File writes apply automatically (each one is checkpointed and shown to the user afterwards as a reviewable diff).
- Work the task to completion: implement, then VERIFY — run get_diagnostics after edits, then run_checks (kind "lint", "typecheck", "test") on every file you changed; it derives the command and runs without a gate. Diagnostics alone are NOT verification: they cannot see a failing assertion, a lint rule the editor does not run, or a type error in a file no editor has opened. run_command is limited to test/build/lint commands in this mode and refuses pipes, redirects and chaining.
- Finish with the FINAL REPORT FORMAT (below) and nothing else — status heading, acceptance criteria table, changes, verification.
- Blocking is the LAST resort here, not a safe default — HOW TO WORK above defines the one case that qualifies, and "nobody is watching" makes taking a sensible default MORE right, not less. Stop early only for an action that would be unsafe to take unattended (a destructive command, a credential, an outward-facing side effect): name it, say why, in one line.
`
      : '';

  const orientationBlock =
    codebaseToolsEnabled && options?.repoOrientation
      ? `**Workspace orientation (pre-fetched — use it to decide where to look first):**\n\`\`\`\n${options.repoOrientation}\n\`\`\`\n`
      : '';

  const rulesBlock =
    codebaseToolsEnabled && options?.workspaceRules
      ? `**Project rules (set by the user/team — follow them; they override your defaults):**\n${options.workspaceRules}\n`
      : '';

  // On a tool turn the workspace rules and orientation must ride along whether
  // or not context was pre-fetched — the earlier shape only emitted them in the
  // no-context branch, because a tool turn never had context before.
  //
  // They are emitted ABOVE the Context rather than inside it: both are fixed
  // for the whole workspace, so keeping them ahead of the first per-question
  // byte puts them inside the cacheable prefix. See the return statement.
  const workspaceBlock = codebaseToolsEnabled ? `${rulesBlock}${orientationBlock}` : '';
  const contextBlock = formattedContext
    ? codebaseToolsEnabled
      ? `**Context (retrieved from Confluence/Azure DevOps before this turn — answer from it when it suffices; verify in the workspace with your tools when it does not):**\n\`\`\`\n${formattedContext}\n\`\`\`\n`
      : `**Context (ONLY source of truth — do NOT add information not found here):**\n\`\`\`\n${formattedContext}\n\`\`\`\n`
    : codebaseToolsEnabled
      ? '**Context:** No other pre-fetched context — use your tools to look at the workspace before answering.\n'
      : '**Context:** No relevant information was found in the indexed data.\n';

  // Files the user attached to THIS message, and files they pointed at with
  // "@" — both shared with createContinuationPrompt below.
  const attachmentsBlock = buildAttachmentsBlock(options);
  const mentionsBlock = buildMentionsBlock(options);

  const ticketBlock = codebaseToolsEnabled
    ? buildTicketBlock(
        options?.ticketContext,
        !!options?.implementMandate,
        !!options?.ticketLookupOnly,
      )
    : '';

  // ── Block order is a caching decision as much as a prompt one ──
  // Every round of an agent run resends this whole string, and so does every
  // follow-up turn in the conversation. Providers cache the longest identical
  // TOKEN PREFIX, so the ordering rule is simply: most stable first, and
  // nothing per-question ahead of anything workspace-wide.
  //
  //   stable for the mode      personality/grounding, how-to-work, the tool
  //                            playbook (contextInstruction — the single
  //                            largest block here)
  //   stable for the workspace project rules, repo orientation
  //   per day / per user       today's date, ADO identity + sprint
  //   per conversation         ticket
  //   per turn                 retrieved context, sources, chat history,
  //                            @-mentions, attachments, the question
  //
  // contextInstruction used to sit AFTER the ticket, which put a few thousand
  // tokens of fixed playbook behind the first bytes that differ between two
  // tickets — so none of it could be served from cache. Nothing here is
  // reworded; only the order changed, and the question stays last.
  return `
${personalityPrompt}
${howToWorkBlock}${planModeBlock}${autonomousBlock}${options?.autonomous && !options?.ticketContext ? FINAL_REPORT_FORMAT : ''}${contextInstruction}

${workspaceBlock}${todayBlock}${adoContextBlock}
${ticketBlock}${contextBlock}${sourcesMarkdown}

**Chat History:**
\`\`\`
${chatHistory || 'No prior conversation.'}
\`\`\`

${mentionsBlock}${attachmentsBlock}${executeMandateBlock}**User Question:**
\`\`\`
${prompt}
\`\`\`

**Answer (formatted in Markdown):**
${
  chatOnly
    ? 'Answer the question directly. If it depends on the user\'s tickets, docs or codebase, say you are in Chat mode without access to them and point them to Work mode instead of guessing. Do not add a Sources section — nothing was retrieved this turn.'
    : codebaseToolsEnabled
    ? options?.executeMandate
      ? 'Make the approved changes now with your write tools, then report what you changed and the result of `get_diagnostics`. Do not ask whether to proceed, and do not restate the plan.'
      : withContext
        ? 'Answer from the Context above when it suffices, verifying in the workspace with your tools when it does not. Use ONLY facts from the Context or from tool results in this turn. ALWAYS end with a **Sources** section: list the "Provided Sources" links you relied on (ONLY links from that list, never invented ones), and add the workspace file paths (with line numbers where useful) for anything you verified in the code. If you relied on none of the Provided Sources, say so in that section in one line rather than omitting it.'
        : 'Explore the workspace with your tools first, then respond using ONLY facts you verified via tool results in this turn. Cite the relevant file paths (with line numbers where useful).'
    : 'Respond using ONLY facts from the Context above. At the end, include a **Sources** section with ONLY links from the "Provided Sources" list above. Do NOT fabricate or modify any links.'
}
`;
}

/**
 * The user turn appended to a RESUMED agent transcript — a run that was cut
 * short by a provider error, a crash, or the user pressing stop, and whose
 * tool calls and results are still sitting above it in `messages`.
 *
 * Deliberately lean: the full personality/grounding preamble, workspace
 * orientation and project rules are all in the FIRST user turn of that
 * transcript already, and repeating them mid-conversation costs thousands of
 * tokens while reading as a fresh start — the exact thing this turn must not
 * be. Only the turn-scoped extras (new attachments, new @-mentions) and the
 * resume framing belong here.
 */
export function createContinuationPrompt(
  prompt: string,
  options?: TurnExtras & {
    executeMandate?: boolean;
    toolResultsAbove?: number;
    /**
     * Set when the previous segment ended at the harness's step cap or
     * tool-output budget rather than by interruption. Its "no further tools"
     * message has been stripped from the transcript (resumeHygiene.ts); the
     * model still has to be told the budget is fresh, or it reads its own
     * "Partially done" answer above as the state of play and stops again.
     */
    previousSegmentEndedAt?: LimitKind | null;
  }
): string {
  const gathered = options?.toolResultsAbove
    ? ` You already have ${options.toolResultsAbove} tool result(s) above`
    : ' You already have tool results above';

  const howItEnded = options?.previousSegmentEndedAt
    ? `That run stopped when it hit the harness's ${
        HARNESS_LIMIT_NOUN[options.previousSegmentEndedAt]
      }, and the partial report above is what the user saw. **This segment starts with a fresh step and tool-output budget: your tools are available again.** The limit no longer applies — do not repeat it, do not answer "Partially done" for that reason, and do not list files to read "when the run resumes": read them now.`
    : 'That run did not finish: it was cut short by a provider error or by the user stopping it, and no final answer was ever delivered.';

  const resumeBlock = `## THIS TURN RESUMES AN INTERRUPTED RUN
Everything above is YOUR OWN work on this same task — the tools you called and what they returned. ${howItEnded}

- **Do not start over.**${gathered} — treat them as current and continue from the exact point you stopped.
- **Do not re-read a file whose content already appears above**, and do not re-run a search you already ran. Re-check something only if you have a concrete reason to believe it changed since you looked (for example, you edited it after reading it).
- **File changes reported as applied above are already on disk.** Do not make them again, and do not describe them as still to do.
- Do the work that was left, then give ONE final answer covering the WHOLE task — including what you had already done before the interruption, since the user never saw a summary of it.
`;

  const executeMandateBlock = options?.executeMandate
    ? `\nThe user's message below approves this work. Carry it out with \`edit_file\`/\`create_file\` now — do not restate the plan and do not ask for permission.\n`
    : '';

  return `${resumeBlock}
${buildMentionsBlock(options)}${buildAttachmentsBlock(options)}${executeMandateBlock}
**The user's message now:**
\`\`\`
${prompt}
\`\`\`

Continue the task and finish it.`;
}
