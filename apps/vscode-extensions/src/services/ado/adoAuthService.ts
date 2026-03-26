import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';

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

export class AdoAuthService {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Saves the provided Personal Access Token securely in VS Code secrets.
   */
  async savePat(pat: string): Promise<void> {
    if (!pat || pat.trim() === '') {
      throw new Error('Personal Access Token cannot be empty.');
    }
    await this.context.secrets.store(STORAGE_KEYS.ADO_OAUTH_TOKENS, pat.trim());
  }

  /**
   * Retrieves the raw PAT from secure storage.
   */
  async getRawPat(): Promise<string> {
    const pat = await this.context.secrets.get(STORAGE_KEYS.ADO_OAUTH_TOKENS);
    if (!pat) {
      throw new Error('Not authenticated with Azure DevOps. Please connect first.');
    }
    return pat;
  }

  /**
   * Returns the Authorization header value using Basic Auth formatting required by ADO PATs.
   * Format: `Basic [base64(:PAT)]`
   */
  async getValidAuthHeader(): Promise<string> {
    const pat = await this.getRawPat();
    return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
  }

  /**
   * Compatibility method to return the proxy method's 'accessToken'.
   * It returns the raw PAT string, but callers should ideally formulate requests using `getValidAuthHeader()`.
   */
  async getValidAccessToken(): Promise<string> {
    return this.getRawPat();
  }

  async fetchOrganizations(): Promise<AdoOrganization[]> {
    return [
      {
        accountId: "mock-org-id",
        accountUri: "https://dev.azure.com/mock-org",
        accountName: "mock-org"
      }
    ];
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
    await this.context.secrets.delete(STORAGE_KEYS.ADO_OAUTH_TOKENS);
  }

  async isAuthenticated(): Promise<boolean> {
    const pat = await this.context.secrets.get(STORAGE_KEYS.ADO_OAUTH_TOKENS);
    return !!pat;
  }

}
