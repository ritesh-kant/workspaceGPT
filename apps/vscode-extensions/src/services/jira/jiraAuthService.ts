import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';

/**
 * Jira Cloud auth — API token only for v1 (JIRA-INTEGRATION-DESIGN.md §5 P2).
 *
 * Jira Cloud's Basic auth needs BOTH the account email and the API token on
 * every request (`Basic base64(email:token)`) — unlike Azure DevOps, whose
 * PAT mode accepts a blank username. Only the token is a secret; the email
 * and site URL are ordinary settings (config.jira.*), same as ADO's
 * org/project names, so every method that builds a header takes email as an
 * explicit parameter rather than reaching into settings itself — the caller
 * (JiraTicketProvider, or the connect/discovery flow) already has it.
 *
 * OAuth 2.0 (3LO) is deferred — see design doc §5 P2 for why (a registered
 * Atlassian app, callback handling, refresh-token rotation, `cloudid`
 * resolution). Nothing here assumes API-token auth is the only mode there
 * will ever be, but nothing here supports a second mode yet either.
 */

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  /** Jira's own REST self-link for the project — mirrors AdoProject.url, which is also an API url, not a browse url. */
  url: string;
}

export interface JiraIdentity {
  accountId: string;
  displayName: string;
}

/** "yourcompany.atlassian.net" or a pasted full URL → "https://yourcompany.atlassian.net", no trailing slash. */
export function normalizeSiteUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function jiraGet(url: string, authHeader: string, what: string): Promise<any> {
  const response = await fetch(url, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Jira rejected the request — the email/API token may be wrong or revoked. Reconnect Jira in Settings.');
    }
    const body = await response.text().catch(() => '');
    throw new Error(`Could not ${what} (${response.status}): ${body.slice(0, 200)}`);
  }
  return response.json();
}

export class JiraAuthService {
  constructor(private context: vscode.ExtensionContext) {}

  async isAuthenticated(): Promise<boolean> {
    return !!(await this.context.secrets.get(STORAGE_KEYS.JIRA_API_TOKEN));
  }

  private async getApiToken(): Promise<string> {
    const token = await this.context.secrets.get(STORAGE_KEYS.JIRA_API_TOKEN);
    if (!token) {
      throw new Error('Not authenticated with Jira. Please connect first.');
    }
    return token;
  }

  /** `Basic email:token` — every Jira REST call needs this, not just connect-time validation. */
  async getValidAuthHeader(email: string): Promise<string> {
    const token = await this.getApiToken();
    if (!email) {
      throw new Error('Jira email is missing from settings. Reconnect Jira.');
    }
    return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  }

  /**
   * Validates site URL + email + token together against `/myself` and stores
   * the token in secrets only on success — unlike ADO's PAT mode, a bad Jira
   * credential can't be told apart from a bad URL without making the call, so
   * there is nothing safe to persist before this succeeds.
   */
  async connectWithApiToken(siteUrl: string, email: string, apiToken: string): Promise<JiraIdentity> {
    const site = normalizeSiteUrl(siteUrl);
    const trimmedEmail = email.trim();
    const trimmedToken = apiToken.trim();
    if (!site) {
      throw new Error('Enter your Jira site URL, e.g. "yourcompany.atlassian.net".');
    }
    if (!trimmedEmail) {
      throw new Error('Enter the email address for this Jira account.');
    }
    if (!trimmedToken) {
      throw new Error('API token cannot be empty.');
    }

    const authHeader = `Basic ${Buffer.from(`${trimmedEmail}:${trimmedToken}`).toString('base64')}`;
    const me = await jiraGet(`${site}/rest/api/3/myself`, authHeader, 'verify Jira credentials');
    const accountId = me?.accountId;
    if (!accountId) {
      throw new Error('Jira did not return an account id — check the site URL and try again.');
    }

    await this.context.secrets.store(STORAGE_KEYS.JIRA_API_TOKEN, trimmedToken);
    return { accountId, displayName: me?.displayName || trimmedEmail };
  }

  /**
   * Re-validates the stored token against `/myself` — the "Check connection"
   * action. There is no ADO-style item-count to report here (no sync exists
   * yet to have counted anything, design doc §5 P5); a working identity
   * fetch is the whole check.
   */
  async checkConnection(siteUrl: string, email: string): Promise<JiraIdentity> {
    const site = normalizeSiteUrl(siteUrl);
    const authHeader = await this.getValidAuthHeader(email);
    const me = await jiraGet(`${site}/rest/api/3/myself`, authHeader, 'verify Jira connection');
    const accountId = me?.accountId;
    if (!accountId) {
      throw new Error('Jira did not return an account id.');
    }
    return { accountId, displayName: me?.displayName || email };
  }

  /**
   * Projects visible to this account, alphabetical. Paginates `project/search`
   * (the current, non-deprecated endpoint) until `isLast` — a site with more
   * than one page of projects is not rare the way it would be for ADO's
   * org→project list.
   */
  async fetchProjects(siteUrl: string, email: string): Promise<JiraProject[]> {
    const site = normalizeSiteUrl(siteUrl);
    const authHeader = await this.getValidAuthHeader(email);
    const projects: JiraProject[] = [];
    let startAt = 0;
    const maxResults = 50;

    for (;;) {
      const url = `${site}/rest/api/3/project/search?maxResults=${maxResults}&startAt=${startAt}&orderBy=name`;
      const page = await jiraGet(url, authHeader, 'fetch Jira projects');
      for (const p of page?.values ?? []) {
        projects.push({ id: String(p.id), key: p.key, name: p.name, url: p.self });
      }
      if (page?.isLast !== false || !page?.values?.length) break;
      startAt += maxResults;
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async disconnect(): Promise<void> {
    await this.context.secrets.delete(STORAGE_KEYS.JIRA_API_TOKEN);
  }
}
