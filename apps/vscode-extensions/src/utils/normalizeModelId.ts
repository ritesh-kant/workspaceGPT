/**
 * Strips the `models/` resource-name prefix from a model id.
 *
 * Gemini's OpenAI-compatibility layer is asymmetric: `models.list()` returns
 * Google's *native* resource names ("models/gemini-2.5-flash"), while the
 * documented form for `/chat/completions` is the bare id ("gemini-2.5-flash")
 * — every sample at https://ai.google.dev/gemini-api/docs/openai uses it
 * unprefixed. Feeding a listed id straight back to completions therefore sends
 * a form Google never documents as accepted.
 *
 * Conformance, not a diagnosed fix: an observed empty-body 404 here turned out
 * to be an unavailable model id, and reproduced with the bare form too. Send
 * the documented shape regardless.
 *
 * Applied at every completions call site rather than when the list is fetched,
 * so ids already persisted in globalState are fixed too, with no migration.
 *
 * Only a LEADING `models/` is removed. Router providers legitimately use
 * slash-namespaced ids ("google/gemini-2.0-flash-exp",
 * "meta-llama/Llama-3.3-70B-Instruct"); none of them start with `models/`.
 */
export function normalizeModelId(modelId: string): string {
  return modelId.replace(/^models\//, '');
}
