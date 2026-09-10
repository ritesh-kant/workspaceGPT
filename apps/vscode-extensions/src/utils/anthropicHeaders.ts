/**
 * Detects if a baseURL points to the Anthropic API.
 */
export function isAnthropicEndpoint(baseURL?: string): boolean {
  return typeof baseURL === 'string' && baseURL.includes('anthropic.com');
}

/**
 * Anthropic's API requires `anthropic-version` and `x-api-key` headers when
 * accessed directly via the OpenAI SDK compatibility layer.
 */
export function getAnthropicHeaders(apiKey?: string): Record<string, string> {
  return {
    'anthropic-version': '2023-06-01',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  };
}

/**
 * Returns defaultHeaders for OpenAI client if pointing to Anthropic, or undefined.
 */
export function getProviderDefaultHeaders(
  baseURL?: string,
  apiKey?: string
): Record<string, string> | undefined {
  if (!isAnthropicEndpoint(baseURL)) {
    return undefined;
  }
  return getAnthropicHeaders(apiKey);
}
