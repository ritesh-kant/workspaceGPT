import * as vscode from 'vscode';
import { STORAGE_KEYS } from '../../../constants';
import { MyTicketsResult, TicketSummary } from '../tickets/types';
import { JiraAuthService, jiraApiBase } from './jiraAuthService';

/**
 * "Your work" for Jira — JIRA-INTEGRATION-DESIGN.md §5 P6.
 *
 * Sprint here is the genuinely uncertain part (design doc §8 risk 3): Jira's
 * Sprint field is a CUSTOM field whose id varies per site, and its value
 * shape is less standardized than everything else this integration touches.
 * This resolves the field id once (via /rest/api/3/field, matching on name +
 * the Jira Software sprint schema type) and caches it — never hardcoded —
 * but the value-parsing below is the one piece of this whole integration
 * that could not be checked against a live site. If a real site's sprint
 * field comes back a different shape, this is where to look first.
 */

interface JiraRequestContext {
  authHeader: string;
  /** `https://api.atlassian.com/ex/jira/{cloudId}` — every REST call goes here, not the site's own domain. */
  apiBase: string;
  /** The site's real domain — for building `/browse/{key}` links only. */
  siteUrl: string;
}

async function getRequestContext(context: vscode.ExtensionContext): Promise<JiraRequestContext> {
  const authService = new JiraAuthService(context);
  const site = authService.getStoredSite();
  if (!site) {
    throw new Error('Jira is not connected. Connect it in Settings → Jira.');
  }
  const authHeader = await authService.getValidAuthHeader();
  return { authHeader, apiBase: jiraApiBase(site.id), siteUrl: site.url };
}

async function jiraGet(ctx: JiraRequestContext, url: string, what: string): Promise<any> {
  const response = await fetch(url, { headers: { Authorization: ctx.authHeader, Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Could not ${what} (${response.status}): ${body.slice(0, 200)}`);
  }
  return response.json();
}

/**
 * The Sprint field's id ("customfield_10020" or similar), resolved once per
 * site and cached in settings. `/rest/api/3/field` lists every field
 * (system and custom); the Jira Software sprint field is identified by its
 * schema's `custom` type (`com.pyxis.greenhopper.jira:gh-sprint`) rather than
 * by name alone, since a site could have renamed or duplicated a
 * similarly-named custom field.
 */
async function resolveSprintFieldId(context: vscode.ExtensionContext, ctx: JiraRequestContext): Promise<string | null> {
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  const cached = settings?.state?.config?.jira?.sprintFieldId;
  if (cached) return cached;

  try {
    const fields = await jiraGet(ctx, `${ctx.apiBase}/rest/api/3/field`, 'resolve the Sprint field');
    const sprintField = (fields ?? []).find(
      (f: any) => f?.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint'
    );
    const fieldId = sprintField?.id ?? null;
    if (fieldId && settings?.state?.config?.jira) {
      settings.state.config.jira.sprintFieldId = fieldId;
      await context.globalState.update(STORAGE_KEYS.SETTINGS, settings);
    }
    return fieldId;
  } catch (error) {
    console.warn('Could not resolve Jira Sprint field (continuing without sprint info):', error);
    return null;
  }
}

/**
 * The active sprint for `projectKey`'s board(s), or null when the project
 * has no board (a Kanban-only or "Business"-template project, or a Scrum
 * board with nothing currently active) — matching AdoAuthService's
 * fetchCurrentSprint philosophy of failing silently rather than surfacing a
 * setup detail as an error.
 */
async function fetchActiveSprint(ctx: JiraRequestContext, projectKey: string): Promise<{ id: number; name: string } | null> {
  try {
    const boards = await jiraGet(
      ctx,
      `${ctx.apiBase}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`,
      'list boards'
    );
    for (const board of boards?.values ?? []) {
      try {
        const sprints = await jiraGet(
          ctx,
          `${ctx.apiBase}/rest/agile/1.0/board/${board.id}/sprint?state=active`,
          'fetch active sprint'
        );
        const active = sprints?.values?.[0];
        if (active) return { id: active.id, name: active.name };
      } catch {
        continue; // this board doesn't support sprints (e.g. Kanban) — try the next
      }
    }
    return null;
  } catch (error) {
    console.warn('Could not detect Jira active sprint (continuing without):', error);
    return null;
  }
}

/**
 * A Sprint field's value, as Jira Cloud most commonly returns it: an array of
 * sprint objects (an issue accumulates one entry per sprint it has ever been
 * in). Take the last entry as "the sprint this issue is currently read as
 * being in" — for an open issue that's the most recent one it was placed in,
 * which is the one that matters for display and for the current-sprint
 * comparison below.
 */
function latestSprintFromFieldValue(value: unknown): { id: number; name: string } | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const last = value[value.length - 1];
  if (last && typeof last === 'object' && 'name' in last) {
    return { id: Number((last as any).id), name: String((last as any).name) };
  }
  return undefined;
}

const TERMINAL_STATUS_CATEGORY = 'Done';
const MY_WORK_ITEMS_LIMIT = 50;

export async function listMyJiraTickets(context: vscode.ExtensionContext): Promise<MyTicketsResult> {
  const ctx = await getRequestContext(context);
  const settings: any = context.globalState.get(STORAGE_KEYS.SETTINGS);
  const projectKey = settings?.state?.config?.jira?.projectKey;

  const sprintFieldId = await resolveSprintFieldId(context, ctx);
  const activeSprint = projectKey ? await fetchActiveSprint(ctx, projectKey) : null;

  const fields = ['summary', 'issuetype', 'status', 'updated', ...(sprintFieldId ? [sprintFieldId] : [])];
  const jql =
    `assignee = currentUser() AND statusCategory != "${TERMINAL_STATUS_CATEGORY}"` +
    (projectKey ? ` AND project = "${projectKey}"` : '') +
    ' ORDER BY updated DESC';

  const result = await jiraGet(
    ctx,
    `${ctx.apiBase}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${MY_WORK_ITEMS_LIMIT}&fields=${fields.join(',')}`,
    'query your Jira issues'
  );

  const items: TicketSummary[] = (result.issues ?? []).map((issue: any): TicketSummary => {
    const f = issue.fields ?? {};
    const sprint = sprintFieldId ? latestSprintFromFieldValue(f[sprintFieldId]) : undefined;
    return {
      id: issue.key,
      title: f.summary ?? '(untitled)',
      type: f.issuetype?.name ?? 'Issue',
      state: f.status?.name ?? 'Unknown',
      sprint: sprint?.name,
      changedDate: f.updated,
      url: `${ctx.siteUrl}/browse/${issue.key}`,
      inCurrentSprint: !!(activeSprint && sprint && sprint.id === activeSprint.id),
    };
  });

  return {
    items,
    currentSprintName: activeSprint?.name,
    fetchedAt: new Date().toISOString(),
  };
}
