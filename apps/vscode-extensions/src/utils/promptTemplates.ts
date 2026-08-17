import { EmbeddingSearchResult } from 'src/types/types';

export function createStructuredPrompt(
  searchResults: EmbeddingSearchResult[],
  prompt: string,
  chatHistory: string = '',
  currentUserName?: string,
  currentSprint?: { name: string; iterationPath: string; startDate: string; endDate: string } | null,
  options?: { codebaseToolsEnabled?: boolean; repoOrientation?: string; workspaceRules?: string }
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

  // Two very different grounding regimes: RAG turns must stay inside the
  // pre-fetched Context, but tool turns have NO pre-fetched context — telling
  // the model "only use the Context below" there hands it a ready-made refusal
  // and directly contradicts the explore-with-tools instructions.
  const groundingRules = toolsEnabled
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
  You are **WorkspaceGPT**, a local, privacy-first AI assistant for developers, designed to run entirely within Visual Studio Code. ${toolsEnabled ? 'You explore the open workspace live with tools to provide intelligent, verified answers about the codebase.' : "You use Retrieval-Augmented Generation (RAG) to provide intelligent, context-aware responses based on the user's codebase and integrated documentation."}

  **Today's date: ${today}.** Use this to interpret relative time references like "current sprint", "this week", "recent", or "upcoming" based on sprint dates visible in the provided context.

  ${groundingRules}

  ## Response Style:
  - Sound like a senior engineer — helpful, concise, and confident.
  - Always format responses in Markdown for readability.
  - Avoid small talk. Be to-the-point and helpful.
  - **ADO Tickets**: When answering about Azure DevOps tickets, ALWAYS explicitly mention its Status, assigned Sprint (Iteration), and any notable callouts from its Comments/Description — but ONLY if this information exists in the provided context.
  `;

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

  const contextInstruction = isGreeting
    ? 'The user greeted you. Respond with a warm, friendly greeting. **Do NOT use any context.**'
    : codebaseToolsEnabled
      ? 'Answer the user\'s question about this codebase. You have live tools to explore the open workspace; use them to find and verify facts before answering rather than guessing. Only state things you have actually confirmed via a tool call. ' +
        'NEVER reply with a plan or an announcement of which tools you intend to use — invoke the tools immediately, in this same turn, via the function-calling mechanism. A reply like "I will use find_files to locate the file" without an actual tool invocation is a failure. Do not write JSON tool calls into your text either. ' +
        'Pick the right tool for the job: `find_symbol` for "where is X defined" when you know a symbol name (exact language-index answers, better than text search); `find_references`/`go_to_definition` to trace how a symbol is used once you\'ve located one occurrence; `search_codebase` for text/regex content search (use `outputMode: "files_with_matches"` first to cheaply survey which files matter, then read the interesting ones); `find_files` to locate files by NAME pattern; `list_directory` and `read_file` to inspect structure and content directly. You may request several independent tool calls in a single turn — they run in parallel. ' +
        'A single search rarely settles a question — `search_codebase` only matches the literal text you pass it, so a query worded differently than the source (e.g. asking about "filters" when the doc says "criteria" or "options") can come back empty even when the answer is right there. It also cannot find a feature whose *implementation* never uses the words used to *describe* it — a design doc talking about "leads and funnel" may be implemented in a component named `LeadsView.tsx` that never contains that phrase. ' +
        'Before concluding something isn\'t in the codebase: retry `search_codebase` with different keywords (individual words, synonyms, related terms); try `find_symbol` and `find_files` with the feature/entity name; `read_file` plausibly-relevant files directly. Only say the information isn\'t there after content search, symbol search, AND name search have all failed. ' +
        'Answer from BOTH documentation and implementation when both exist — docs describe intent, code is the ground truth for what actually exists. ' +
        'IMPORTANT: chat history may contain earlier claims about what was or was not found in the codebase — do NOT rely on them. The workspace may have changed and earlier searches may have been weaker. Verify with fresh tool calls in THIS turn before answering. ' +
        'You can also CHANGE the workspace when the user asks for it: `edit_file` replaces exact text in a file (read the file first and copy oldString verbatim — exact match, unique unless replaceAll), `create_file` makes new files, `delete_file` removes them. Every write is shown to the user as a diff for approval before it is applied; a rejection returns their feedback — adjust and try again rather than repeating the same edit. Prefer several small, focused edits over one sweeping rewrite. After edits are applied, call `get_diagnostics` to verify you introduced no compile/type errors, and fix any you did. Never edit files the user did not ask you to change. ' +
        'For repo context: `git_status`/`git_diff` show uncommitted work, `git_log` shows recent history, `git_blame` explains who last touched a line range — all read-only. ' +
        '`run_command` executes shell commands (tests, builds, linters) with user approval — after non-trivial edits, run the relevant test or build and FIX failures before declaring the task done. Keep commands non-interactive (no watch modes, no prompts). ' +
        'Org knowledge: `search_docs` (Confluence design docs/architecture) and `search_tickets` (Azure DevOps work items) ground your work in the organization\'s actual context. When implementing a ticket or an org-described feature, read the ticket/doc FIRST, then explore the code — cite what the doc says when it drives a decision.'
      : 'Answer the user\'s question using ONLY the context provided below. If the context does not contain relevant information, clearly state that you don\'t have the data rather than guessing.';

  const orientationBlock =
    codebaseToolsEnabled && options?.repoOrientation
      ? `**Workspace orientation (pre-fetched — use it to decide where to look first):**\n\`\`\`\n${options.repoOrientation}\n\`\`\`\n`
      : '';

  const rulesBlock =
    codebaseToolsEnabled && options?.workspaceRules
      ? `**Project rules (set by the user/team — follow them; they override your defaults):**\n${options.workspaceRules}\n`
      : '';

  const contextBlock = formattedContext
    ? `**Context (ONLY source of truth — do NOT add information not found here):**\n\`\`\`\n${formattedContext}\n\`\`\`\n`
    : codebaseToolsEnabled
      ? `${rulesBlock}${orientationBlock}**Context:** No other pre-fetched context — use your tools to look at the workspace before answering.\n`
      : '**Context:** No relevant information was found in the indexed data.\n';

  return `
${personalityPrompt}
${adoContextBlock}
${contextInstruction}

${contextBlock}${sourcesMarkdown}

**Chat History:**
\`\`\`
${chatHistory || 'No prior conversation.'}
\`\`\`

**User Question:**
\`\`\`
${prompt}
\`\`\`

**Answer (formatted in Markdown):**
${
  codebaseToolsEnabled
    ? 'Explore the workspace with your tools first, then respond using ONLY facts you verified via tool results in this turn. Cite the relevant file paths (with line numbers where useful).'
    : 'Respond using ONLY facts from the Context above. At the end, include a **Sources** section with ONLY links from the "Provided Sources" list above. Do NOT fabricate or modify any links.'
}
`;
}
