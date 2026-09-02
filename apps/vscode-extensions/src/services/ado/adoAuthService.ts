import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  PublicClientApplication,
  ICachePlugin,
  TokenCacheContext,
  AccountInfo,
} from '@azure/msal-node';
import { ADO_AZURE_CLI, ADO_MSAL, STORAGE_KEYS } from '../../../constants';

const execAsync = promisify(exec);

/** Persists MSAL's token cache to VS Code SecretStorage so a sign-in survives restarts. */
class SecretStorageCachePlugin implements ICachePlugin {
  constructor(private context: vscode.ExtensionContext) {}

  async beforeCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
    const cached = await this.context.secrets.get(STORAGE_KEYS.ADO_MSAL_CACHE);
    if (cached) {
      cacheContext.tokenCache.deserialize(cached);
    }
  }

  async afterCacheAccess(cacheContext: TokenCacheContext): Promise<void> {
    if (cacheContext.cacheHasChanged) {
      await this.context.secrets.store(
        STORAGE_KEYS.ADO_MSAL_CACHE,
        cacheContext.tokenCache.serialize(),
      );
    }
  }
}

export interface AdoOrganization {
  accountId: string;
  accountUri: string;
  accountName: string;
}

export interface AdoProject {
  id: string;
  name: string;
  description: string;
  url: string;
}

type AdoAuthMode = 'msal' | 'azcli' | 'pat';

const ADO_SCOPE = `${ADO_MSAL.RESOURCE_ID}/.default`;

/**
 * Azure DevOps auth — three modes, none requiring a custom Entra ID app
 * registration of our own:
 *
 *  - Microsoft sign-in (MSAL): interactive browser sign-in via Microsoft's
 *    own well-known client id (see ADO_MSAL's doc comment in constants.ts).
 *    MSAL persists its own encrypted-at-rest-by-us token cache in
 *    SecretStorage and transparently refreshes via acquireTokenSilent.
 *  - Azure CLI passthrough: gets a fresh access token from `az` on every
 *    call. `az` keeps its own local token cache and silently refreshes, so
 *    there's nothing for us to persist beyond "which mode is active" — the
 *    CLI call itself is the source of truth.
 *  - Personal Access Token: the raw PAT is stored in SecretStorage and sent
 *    as Basic auth, same as ADO's classic PAT flow.
 */
export class AdoAuthService {
  private context: vscode.ExtensionContext;
  private msalClient: PublicClientApplication | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private getMsalClient(): PublicClientApplication {
    if (!this.msalClient) {
      this.msalClient = new PublicClientApplication({
        auth: {
          clientId: ADO_MSAL.CLIENT_ID,
          authority: ADO_MSAL.AUTHORITY,
        },
        cache: {
          cachePlugin: new SecretStorageCachePlugin(this.context),
        },
      });
    }
    return this.msalClient;
  }

  /**
   * Interactive Microsoft sign-in. Opens the system browser via
   * `vscode.env.openExternal`; MSAL runs its own loopback listener to catch
   * the redirect, so unlike the Azure CLI/PAT modes there's no server we
   * have to manage ourselves.
   */
  async connectWithMicrosoftAccount(): Promise<void> {
    const pca = this.getMsalClient();
    const result = await pca.acquireTokenInteractive({
      scopes: [ADO_SCOPE],
      prompt: 'select_account',
      openBrowser: async (url: string) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
    });
    if (!result?.accessToken) {
      throw new Error('Microsoft sign-in did not return an access token.');
    }
    await this.context.secrets.store(STORAGE_KEYS.ADO_AUTH_MODE, 'msal' as AdoAuthMode);
    await this.context.secrets.delete(STORAGE_KEYS.ADO_PAT);
  }

  private async getMsalAccessToken(): Promise<string> {
    const pca = this.getMsalClient();
    const accounts: AccountInfo[] = await pca.getTokenCache().getAllAccounts();
    const account = accounts[0];
    if (!account) {
      throw new Error('Not signed in with Microsoft. Please connect first.');
    }
    try {
      const result = await pca.acquireTokenSilent({ account, scopes: [ADO_SCOPE] });
      if (!result?.accessToken) {
        throw new Error('Silent token acquisition returned no token.');
      }
      return result.accessToken;
    } catch {
      throw new Error('Microsoft session expired or was revoked. Please reconnect.');
    }
  }

  /**
   * Verifies `az` is installed and logged in by actually requesting a token,
   * then marks Azure CLI as the active auth mode. Throws a descriptive error
   * on failure instead of silently falling through.
   */
  async connectWithAzureCli(): Promise<void> {
    await this.getAzureCliAccessToken();
    await this.context.secrets.store(STORAGE_KEYS.ADO_AUTH_MODE, 'azcli' as AdoAuthMode);
    await this.context.secrets.delete(STORAGE_KEYS.ADO_PAT);
  }

  async connectWithPat(pat: string): Promise<void> {
    const trimmed = pat.trim();
    if (!trimmed) {
      throw new Error('Personal Access Token cannot be empty.');
    }
    await this.context.secrets.store(STORAGE_KEYS.ADO_PAT, trimmed);
    await this.context.secrets.store(STORAGE_KEYS.ADO_AUTH_MODE, 'pat' as AdoAuthMode);
  }

  private async getAzureCliAccessToken(): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await execAsync(
        `az account get-access-token --resource ${ADO_AZURE_CLI.RESOURCE_ID} --output json`,
      ));
    } catch (error: any) {
      const message: string = error?.stderr || error?.message || String(error);
      if (/command not found|not recognized|ENOENT/i.test(message)) {
        throw new Error(
          'Azure CLI (az) was not found. Install it from https://aka.ms/InstallAzureCLI, run "az login", then try again.',
        );
      }
      if (/az login/i.test(message) || /please run/i.test(message)) {
        throw new Error('Not logged in to Azure CLI. Run "az login" in a terminal, then try again.');
      }
      throw new Error(`Azure CLI could not get a token: ${message.trim().split('\n')[0]}`);
    }

    let data: any;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error('Azure CLI returned an unexpected response.');
    }
    if (!data?.accessToken) {
      throw new Error('Azure CLI returned no access token.');
    }
    return data.accessToken;
  }

  /**
   * Returns the Authorization header for ADO REST calls, per the active auth
   * mode. Azure CLI mode re-fetches a token on every call (cheap — the CLI
   * itself caches/refreshes locally); PAT mode reads the stored secret.
   */
  async getValidAuthHeader(): Promise<string> {
    const mode = (await this.context.secrets.get(STORAGE_KEYS.ADO_AUTH_MODE)) as
      | AdoAuthMode
      | undefined;

    if (mode === 'msal') {
      const token = await this.getMsalAccessToken();
      return `Bearer ${token}`;
    }

    if (mode === 'azcli') {
      const token = await this.getAzureCliAccessToken();
      return `Bearer ${token}`;
    }

    if (mode === 'pat') {
      const pat = await this.context.secrets.get(STORAGE_KEYS.ADO_PAT);
      if (!pat) {
        throw new Error('Not authenticated with Azure DevOps. Please connect first.');
      }
      return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
    }

    throw new Error('Not authenticated with Azure DevOps. Please connect first.');
  }

  /**
   * Lists the Azure DevOps organizations the signed-in user is a member of,
   * via the classic vssps "accounts" API (org-agnostic — unlike everything
   * else here, it isn't scoped to `dev.azure.com/{org}`). Requires the
   * caller's member id first, from the profile endpoint.
   */
  async fetchOrganizations(): Promise<AdoOrganization[]> {
    const authHeader = await this.getValidAuthHeader();

    const profileUrl = 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1';
    const profileResponse = await fetch(profileUrl, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!profileResponse.ok) {
      throw new Error(`Failed to fetch ADO profile (${profileResponse.status})`);
    }
    const profile: any = await profileResponse.json();
    const memberId = profile?.id;
    if (!memberId) {
      throw new Error('Could not determine Azure DevOps member id.');
    }

    const accountsUrl = `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${encodeURIComponent(memberId)}&api-version=7.1`;
    const accountsResponse = await fetch(accountsUrl, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
    if (!accountsResponse.ok) {
      throw new Error(`Failed to fetch ADO organizations (${accountsResponse.status})`);
    }
    const data: any = await accountsResponse.json();
    return (data.value || [])
      .map((a: any) => ({
        accountId: a.accountId,
        accountUri: a.accountUri,
        accountName: a.accountName,
      }))
      .sort((a: AdoOrganization, b: AdoOrganization) => a.accountName.localeCompare(b.accountName));
  }

  async fetchProjects(orgName: string): Promise<AdoProject[]> {
    const authHeader = await this.getValidAuthHeader();
    const url = `https://dev.azure.com/${orgName}/_apis/projects?api-version=7.1`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        let errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
           errorText = "Invalid Token or insufficient permissions.";
        }
        throw new Error(`Failed (${response.status}): ${errorText}`);
      }

      const data: any = await response.json();
      return data.value.map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        url: p.url,
      })).sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch ADO projects: ${msg}`);
    }
  }

  /**
   * Fetches the display name of the currently authenticated ADO user.
   * Uses the connectionData endpoint which requires no extra PAT scope.
   */
  async fetchCurrentUser(orgName: string): Promise<{ displayName: string }> {
    const authHeader = await this.getValidAuthHeader();
    const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/_apis/connectionData`;

    const response = await fetch(url, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ADO user identity (${response.status})`);
    }

    const data: any = await response.json();
    const displayName: string = data?.authenticatedUser?.providerDisplayName;
    if (!displayName) {
      throw new Error('Could not determine display name from ADO connection data.');
    }
    return { displayName };
  }

  /**
   * Fetches the current sprint (active iteration) for the given project/team.
   * Tries "{projectName} Team" first, then falls back to "{projectName}".
   */
  async fetchCurrentSprint(
    orgName: string,
    projectName: string,
    teamName?: string
  ): Promise<{ name: string; iterationPath: string; startDate: string; endDate: string } | null> {
    const authHeader = await this.getValidAuthHeader();

    const teamsToTry = teamName
      ? [teamName]
      : [`${projectName} Team`, projectName];

    for (const team of teamsToTry) {
      const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/${encodeURIComponent(projectName)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=7.1`;

      try {
        const response = await fetch(url, {
          headers: { Authorization: authHeader, Accept: 'application/json' },
        });

        if (!response.ok) {
          continue; // Try next team name
        }

        const data: any = await response.json();
        const iterations: any[] = data?.value || [];
        const current = iterations[0];
        if (!current) {
          continue;
        }

        return {
          name: current.name,
          iterationPath: current.path,
          startDate: current.attributes?.startDate || '',
          endDate: current.attributes?.finishDate || '',
        };
      } catch {
        continue;
      }
    }

    return null; // Sprint detection failed silently
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.ADO_AUTH_MODE);
    await this.context.secrets.delete(STORAGE_KEYS.ADO_PAT);
    await this.context.secrets.delete(STORAGE_KEYS.ADO_MSAL_CACHE);
    this.msalClient = null;
  }

  async isAuthenticated(): Promise<boolean> {
    const mode = await this.context.secrets.get(STORAGE_KEYS.ADO_AUTH_MODE);
    return !!mode;
  }

}
