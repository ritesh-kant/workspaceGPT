import * as vscode from 'vscode';
import { getEmbeddingSettings } from './getEmbeddingSettings';
import { getVectorStoreSettings } from './getVectorStoreSettings';
import { getLlmSettings } from './getLlmSettings';

/**
 * Build a share code from the current settings and copy it to the clipboard.
 * The code is a base64-encoded bundle of the user's own credentials; the Chrome
 * extension decodes it and talks directly to Gemini / Qdrant / the LLM. There is
 * no server — the keys live only in the code and in whoever's browser imports it.
 *
 * Requires Gemini embeddings + Qdrant cloud (the only shareable combination).
 */
export async function shareToChrome(context: vscode.ExtensionContext): Promise<void> {
  const embedding = getEmbeddingSettings(context);
  const vectorStore = getVectorStoreSettings(context);
  const llm = getLlmSettings(context);

  const problems: string[] = [];
  if (embedding.provider !== 'gemini' || !embedding.apiKey) {
    problems.push('• Embeddings must be set to Gemini with an API key.');
  }
  if (vectorStore.location !== 'cloud' || !vectorStore.qdrantUrl) {
    problems.push('• Vector store must be set to Qdrant cloud with a URL.');
  }
  if (!llm.apiKey || !llm.baseUrl || !llm.model) {
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
    v: 1 as const,
    qdrant: {
      url: vectorStore.qdrantUrl,
      apiKey: vectorStore.qdrantApiKey,
      collectionPrefix: '',
    },
    gemini: { apiKey: embedding.apiKey },
    llm: { baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model },
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
