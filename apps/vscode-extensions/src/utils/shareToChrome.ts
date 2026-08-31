import * as vscode from 'vscode';
import { getEmbeddingSettings } from './getEmbeddingSettings';
import { getVectorStoreSettings } from './getVectorStoreSettings';
import { getLlmSettings } from './getLlmSettings';

/**
 * PARKED — Share-to-Chrome cannot work while the vector index is local-only.
 *
 * The Chrome extension reads the index directly, so sharing needs a
 * network-reachable one; remote mode now moves inference to the WorkspaceGPT
 * Worker and deliberately leaves indexing on the user's machine, which means
 * there is nothing shareable to point Chrome at. The title-bar action is hidden
 * (EXTENSION.CONTEXT_SHARE_ENABLED is always false) and the preconditions below
 * can no longer be satisfied, so this function now explains that instead of
 * asking for Gemini/Qdrant settings that the mode switch no longer exposes.
 * Kept intact — including the v2 bundle shape — so it can be revived unchanged
 * the day a server-side index exists.
 *
 * Build a share code from the current settings and copy it to the clipboard.
 * The code is a base64-encoded bundle of the user's own credentials; the Chrome
 * extension decodes it and talks directly to Gemini / Qdrant / the LLM. There is
 * no server — the keys live only in the code and in whoever's browser imports it.
 *
 * Requires Gemini embeddings + Qdrant cloud (the only shareable combination).
 * Carries every configured Gemini/chat-model key (not just the first) so the
 * Chrome extension gets the same 429 failover as the VS Code extension — see
 * {@link withKeyFailover} on the Chrome side.
 */
export async function shareToChrome(context: vscode.ExtensionContext): Promise<void> {
  const embedding = getEmbeddingSettings(context);
  const vectorStore = getVectorStoreSettings(context);
  const llm = getLlmSettings(context);

  if (embedding.provider === 'local' || vectorStore.location === 'local') {
    vscode.window.showInformationMessage(
      'Share to Chrome is unavailable right now. The Chrome extension reads the vector index directly, ' +
        'and WorkspaceGPT keeps that index on your machine — there is nothing for another browser to read. ' +
        'It will return once a hosted index is available.',
      { modal: true },
    );
    return;
  }

  const problems: string[] = [];
  if (embedding.provider !== 'gemini' || embedding.apiKeys.length === 0) {
    problems.push('• Embeddings must be set to Gemini with an API key.');
  }
  if (vectorStore.location !== 'cloud' || !vectorStore.qdrantUrl) {
    problems.push('• Vector store must be set to Qdrant cloud with a URL.');
  }
  if (llm.apiKeys.length === 0 || !llm.baseUrl || !llm.model) {
    problems.push('• A chat model with an API key must be selected.');
  }
  if (problems.length) {
    vscode.window.showWarningMessage(
      `Can't create a share code yet. Sharing requires Gemini embeddings + Qdrant cloud:\n\n${problems.join('\n')}`,
      { modal: true },
    );
    return;
  }

  const bundle = {
    v: 2 as const,
    qdrant: {
      url: vectorStore.qdrantUrl,
      apiKey: vectorStore.qdrantApiKey,
      collectionPrefix: '',
    },
    gemini: { apiKeys: embedding.apiKeys },
    llm: { baseUrl: llm.baseUrl, apiKeys: llm.apiKeys, model: llm.model },
  };

  const code = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
  await vscode.env.clipboard.writeText(code);

  const pick = await vscode.window.showInformationMessage(
    'Share code copied to clipboard. It contains your Qdrant, Gemini, and chat-model API keys in plain form — only share it with people you trust. Paste it into the WorkspaceGPT Chrome extension’s Settings.',
    'Copy again',
  );
  if (pick === 'Copy again') {
    await vscode.env.clipboard.writeText(code);
    vscode.window.showInformationMessage('Share code copied to clipboard.');
  }
}
