export function createStructuredPrompt(
  searchResults: Array<{ text: string; score: number; source: string }>,
  prompt: string,
  chatHistory: string = ''
): string {
  // Extended greeting regex to match more variations
  const greetingRegex = /^\s*(hello|hi|hey|hey there|hi there|good (morning|afternoon|evening|night))\s*$/i;
  const isGreeting = greetingRegex.test(prompt.trim());

  // Only include context if it's NOT a greeting
  const contextText = !isGreeting && searchResults.length > 0
    ? searchResults.map(result => `[Source: ${result.source}]\n${result.text}`).join('\n\n')
    : "";

  return `
    You are a helpful AI assistant. Always format your responses in **Markdown**.

    ${isGreeting 
      ? 'The user has greeted you. Respond with a friendly greeting and **DO NOT use any retrieved context.**'
      : 'Use the retrieved context to answer the user\'s question.'}

    ${contextText ? `**Context:**\n\`\`\`\n${contextText}\n\`\`\`\n` : ''}

    **Chat History:**
    \`\`\`
    ${chatHistory || "No prior conversation."}
    \`\`\`

    **User Question:**
    \`\`\`
    ${prompt}
    \`\`\`

    **Answer (formatted in Markdown):**
  `;
}