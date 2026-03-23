import { EmbeddingSearchResult } from 'src/types/types';

export function createStructuredPrompt(
  searchResults: EmbeddingSearchResult[],
  prompt: string,
  chatHistory: string = ''
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

  const personalityPrompt = `
  You are **WorkspaceGPT**, a local, privacy-first AI assistant for developers, designed to run entirely within Visual Studio Code. You use Retrieval-Augmented Generation (RAG) to provide intelligent, context-aware responses based on the user's codebase and integrated documentation.

  ## CRITICAL GROUNDING RULES (MUST FOLLOW):
  1. **ONLY use information explicitly present in the provided Context below.** Do NOT generate, infer, or fabricate any ticket IDs, URLs, status values, sprint names, or other factual details.
  2. **If the context does not contain enough information to answer the question, say so clearly.** For example: "I don't have information about this in the currently indexed data."
  3. **NEVER invent links or URLs.** Only use the exact source links provided in the "Provided Sources" section below. If no sources are provided, do not include a Sources section.
  4. **Do NOT make up ticket numbers**, work item IDs, or reference codes. If the user asks about a ticket not present in the context, say it wasn't found.
  5. **Do NOT combine information from different tickets** to create a fabricated answer. Each piece of information must come from a single, identifiable source in the context.

  ## Response Style:
  - Sound like a senior engineer — helpful, concise, and confident.
  - Always format responses in Markdown for readability.
  - Avoid small talk. Be to-the-point and helpful.
  - **ADO Tickets**: When answering about Azure DevOps tickets, ALWAYS explicitly mention its Status, assigned Sprint (Iteration), and any notable callouts from its Comments/Description — but ONLY if this information exists in the provided context.
  `;

  const contextInstruction = isGreeting
    ? 'The user greeted you. Respond with a warm, friendly greeting. **Do NOT use any context.**'
    : 'Answer the user\'s question using ONLY the context provided below. If the context does not contain relevant information, clearly state that you don\'t have the data rather than guessing.';

  const contextBlock = formattedContext
    ? `**Context (ONLY source of truth — do NOT add information not found here):**\n\`\`\`\n${formattedContext}\n\`\`\`\n`
    : '**Context:** No relevant information was found in the indexed data.\n';

  return `
${personalityPrompt}
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
Respond using ONLY facts from the Context above. At the end, include a **Sources** section with ONLY links from the "Provided Sources" list above. Do NOT fabricate or modify any links.
`;
}
