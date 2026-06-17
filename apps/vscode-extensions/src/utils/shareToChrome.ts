import * as vscode from 'vscode';
import { EMBEDDING_PROFILES } from '@workspace-gpt/embedding-core';
import { getEmbeddingSettings } from './getEmbeddingSettings';
import { getVectorStoreSettings } from './getVectorStoreSettings';
import { getLlmSettings } from './getLlmSettings';

const SECRET_KEY = 'workspacegpt.adminSecret';

/** Read the deployed Worker base URL from settings (workspacegpt.shareWorkerUrl). */
function getWorkerUrl(): string | undefined {
  const url = vscode.workspace.getConfiguration('workspacegpt').get<string>('shareWorkerUrl');
  return url?.trim().replace(/\/+$/, '') || undefined;
}

/** Get the admin secret from SecretStorage, prompting (and saving) if unset. */
async function getAdminSecret(context: vscode.ExtensionContext): Promise<string | undefined> {
  let secret = await context.secrets.get(SECRET_KEY);
  if (secret) return secret;
  secret = await vscode.window.showInputBox({
    title: 'WorkspaceGPT Worker admin secret',
    prompt: 'Enter the ADMIN_SECRET configured on your Cloudflare Worker. Stored securely; asked once.',
    password: true,
    ignoreFocusOut: true,
  });
  if (secret) await context.secrets.store(SECRET_KEY, secret.trim());
  return secret?.trim();
}

/**
 * Build a share bundle from the current settings and POST it to the Worker's
 * /share endpoint, returning a token the user pastes into the Chrome extension.
 * Requires Gemini embeddings + Qdrant cloud (the only shareable combination).
 */
export async function shareToChrome(context: vscode.ExtensionContext): Promise<void> {
  const embedding = getEmbeddingSettings(context);
  const vectorStore = getVectorStoreSettings(context);
  const llm = getLlmSettings(context);

  // Compatibility gating — Chrome can only consume Gemini + Qdrant cloud.
  const problems: string[] = [];
  if (embedding.provider !== 'gemini' || !embedding.apiKey) {
    problems.push('• Embeddings must be set to Gemini with an API key.');
  }
  if (vectorStore.location !== 'cloud' || !vectorStore.qdrantUrl) {
    problems.push('• Vector store must be set to Qdrant cloud with a URL.');
  }
  if (!llm.apiKey || !llm.baseUrl) {
    problems.push('• A chat model with an API key must be selected.');
  }
  if (problems.length) {
    vscode.window.showWarningMessage(
      `Can't share yet. Sharing requires Gemini embeddings + Qdrant cloud:\n\n${problems.join('\n')}`,
      { modal: true },
    );
    return;
  }

  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    vscode.window.showErrorMessage(
      'Set "workspacegpt.shareWorkerUrl" to your deployed Cloudflare Worker URL first.',
    );
    return;
  }
  const adminSecret = await getAdminSecret(context);
  if (!adminSecret) return;

  const label = await vscode.window.showInputBox({
    title: 'Label this share (optional)',
    prompt: 'e.g. a teammate name or device — shown in "Manage Shares".',
    ignoreFocusOut: true,
  });
  if (label === undefined) return; // cancelled

  const bundle = {
    qdrant: {
      url: vectorStore.qdrantUrl,
      apiKey: vectorStore.qdrantApiKey,
      collectionPrefix: '',
    },
    gemini: {
      apiKey: embedding.apiKey,
      model: EMBEDDING_PROFILES.gemini.model,
      dimensions: EMBEDDING_PROFILES.gemini.dimensions,
    },
    llm: {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
    },
    label: label || undefined,
  };

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Creating share…' },
    async () => {
      try {
        const res = await fetch(`${workerUrl}/share`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSecret}` },
          body: JSON.stringify(bundle),
        });
        if (res.status === 401) {
          await context.secrets.delete(SECRET_KEY); // bad secret — clear so we re-prompt next time
          vscode.window.showErrorMessage('Worker rejected the admin secret. Re-run Share to enter it again.');
          return;
        }
        if (!res.ok) {
          vscode.window.showErrorMessage(`Share failed: ${res.status} ${await res.text().catch(() => '')}`);
          return;
        }
        const { token } = (await res.json()) as { token: string };
        const pick = await vscode.window.showInformationMessage(
          'Share created. Paste this code into the WorkspaceGPT Chrome extension settings.',
          'Copy code',
        );
        if (pick === 'Copy code') {
          await vscode.env.clipboard.writeText(token);
          vscode.window.showInformationMessage('Share code copied to clipboard.');
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Share failed: ${err?.message ?? err}`);
      }
    },
  );
}

/** List existing shares and let the admin revoke one. */
export async function manageShares(context: vscode.ExtensionContext): Promise<void> {
  const workerUrl = getWorkerUrl();
  if (!workerUrl) {
    vscode.window.showErrorMessage('Set "workspacegpt.shareWorkerUrl" first.');
    return;
  }
  const adminSecret = await getAdminSecret(context);
  if (!adminSecret) return;

  let shares: { token: string; label: string; createdAt: string }[] = [];
  try {
    const res = await fetch(`${workerUrl}/shares`, {
      headers: { Authorization: `Bearer ${adminSecret}` },
    });
    if (res.status === 401) {
      await context.secrets.delete(SECRET_KEY);
      vscode.window.showErrorMessage('Worker rejected the admin secret. Try again.');
      return;
    }
    if (!res.ok) {
      vscode.window.showErrorMessage(`Couldn't load shares: ${res.status}`);
      return;
    }
    shares = ((await res.json()) as { shares: typeof shares }).shares;
  } catch (err: any) {
    vscode.window.showErrorMessage(`Couldn't load shares: ${err?.message ?? err}`);
    return;
  }

  if (!shares.length) {
    vscode.window.showInformationMessage('No active shares.');
    return;
  }

  const pick = await vscode.window.showQuickPick(
    shares.map((s) => ({
      label: s.label || '(unlabeled)',
      description: s.createdAt ? new Date(s.createdAt).toLocaleString() : '',
      detail: `Revoke ${s.token.slice(0, 8)}…`,
      token: s.token,
    })),
    { title: 'Manage Shares — select one to revoke', ignoreFocusOut: true },
  );
  if (!pick) return;

  const confirm = await vscode.window.showWarningMessage(
    `Revoke share "${pick.label}"? The connected extension will stop working immediately.`,
    { modal: true },
    'Revoke',
  );
  if (confirm !== 'Revoke') return;

  try {
    const res = await fetch(`${workerUrl}/share/${encodeURIComponent(pick.token)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminSecret}` },
    });
    if (!res.ok) {
      vscode.window.showErrorMessage(`Revoke failed: ${res.status}`);
      return;
    }
    vscode.window.showInformationMessage(`Revoked "${pick.label}".`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Revoke failed: ${err?.message ?? err}`);
  }
}
