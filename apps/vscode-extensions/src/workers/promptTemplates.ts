export function createStructuredPrompt(searchResults: Array<{ text: string; score: number; source: string }>, prompt: string): string {
  // Create context text from search results
  const contextText = searchResults
    .map(result => `[Source: ${result.source}]\n${result.text}`)
    .join('\n\n');

  // Return formatted prompt template
  return `Context Information:\n${contextText}\n\nUser Question: ${prompt}\n\nAssistant: Let me help you with that based on the available information.`;
}