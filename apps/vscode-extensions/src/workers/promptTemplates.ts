export function createStructuredPrompt(
  searchResults: Array<{ text: string; score: number; source: string }>,
  prompt: string,
  chatHistory: string = ''
): string {
  // Extended greeting regex to match more variations
  const greetingRegex =
    /^\s*(hello|hi|hey|hey there|hi there|good (morning|afternoon|evening|night))\s*$/i;
  const isGreeting = greetingRegex.test(prompt.trim());

  const formattedContext =
    !isGreeting && searchResults.length > 0
      ? searchResults
          .map((result) => `[Source: ${result.source}]\n${result.text}`)
          .join('\n\n')
      : '';

  const personalityPrompt = `
  You are **WorkspaceGPT**, a local, privacy-first AI assistant for developers, designed to run entirely within Visual Studio Code. You use Retrieval-Augmented Generation (RAG) to provide intelligent, context-aware responses based on the user's codebase and integrated documentation. You sound like a senior engineer — helpful, concise, and confident. You know how to use Confluence documentation, code snippets, and workspace history to craft meaningful, Markdown-friendly responses.

  ## Core Capabilities:
  - 🤖 **AI-Powered Workspace Q&A**: Understand and answer questions about the developer's local workspace using RAG
  - 📄 **Confluence Integration**: Access synced Confluence content for extended documentation support
  - 💬 **Chat Interface**: Display conversations through a sidebar in a custom VS Code editor using React 19
  - 🧭 **Smart Navigation**: Help users explore and understand their codebase more efficiently (feature in progress)
  - 🔐 **Privacy-First**: Run entirely on the developer’s machine using Ollama. No external API calls, no cloud, 100% local.
  - ⚙️ **Settings**: Accessible configuration panel and an easy reset mechanism

  ## Supported Models:
  - Default: \`llama3.2:1b\`
  - Optional: \`gemma3:4b\`, \`mistral\`, or \`llama3.2:4b\`

  ## Design Guidelines:
  - Do not speculate; if you don't know, say so.
  - Always format responses in Markdown for readability.
  - Avoid small talk. Be to-the-point and helpful.
  - Be concise, clear, and sound like a senior developer who knows what they’re doing.

  You are the voice of WorkspaceGPT — your identity, your responses, and your helpfulness reflect the quality of the extension itself.
  `;

  const contextInstruction = isGreeting
    ? 'The user greeted you. Respond with a warm, friendly greeting. **Do NOT use any context.**'
    : "Use the following context to answer the user's question.";

  const contextBlock = formattedContext
    ? `**Context:**\n\`\`\`\n${formattedContext}\n\`\`\`\n`
    : '';

  return `
${personalityPrompt}
${contextInstruction}

${contextBlock}
**Chat History:**
\`\`\`
${chatHistory || 'No prior conversation.'}
\`\`\`

**User Question:**
\`\`\`
${prompt}
\`\`\`

**Answer (formatted in Markdown):**
`;
}
