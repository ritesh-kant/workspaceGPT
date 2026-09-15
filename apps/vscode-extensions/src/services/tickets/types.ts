/**
 * Provider-neutral ticket shapes.
 *
 * These used to be declared inside adoWorkItemService.ts, ADO-specific by
 * file even though nothing in their shape was. This is the extraction
 * JIRA-INTEGRATION-DESIGN.md §4 calls for: adoWorkItemService.ts now imports
 * and re-exports these (so every existing `from '../ado/adoWorkItemService'`
 * import keeps working, unchanged), and a future JiraTicketProvider returns
 * the same shapes without owing anything to the ADO module.
 *
 * `id`/`parentId` are strings throughout — an ADO work item's id happens to
 * be a digit run, but a Jira issue key ("PROJ-123") is not, and nothing here
 * should assume otherwise. See JIRA-INTEGRATION-DESIGN.md §3.
 */

export interface TicketComment {
  author: string;
  date?: string;
  text: string;
}

export interface TicketImage {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface TicketDetail {
  id: string;
  title: string;
  type: string;
  state: string;
  assignedTo?: string;
  sprint?: string;
  area?: string;
  tags?: string[];
  /** ADO gives a numeric level (1-4); Jira names one ("High", "Medium", …) — currently carried but unread anywhere. */
  priority?: number | string;
  createdDate?: string;
  changedDate?: string;
  url: string;
  description?: string;
  acceptanceCriteria?: string;
  /** Parent ticket (epic/feature) when this one is part of a hierarchy. */
  parentId?: string;
  /** Only populated when the caller asked for comments. */
  comments?: TicketComment[];
  /** Screenshots/diagrams embedded in the description, base64-encoded for vision models. */
  images?: TicketImage[];
}

/** One row in "your work" — a ticket assigned to the signed-in user. */
export interface TicketSummary {
  id: string;
  title: string;
  type: string;
  state: string;
  /** Full sprint/iteration path, however the provider spells it. */
  sprint?: string;
  url: string;
  changedDate?: string;
  /** True when this ticket sits in (or under) the team's current sprint. */
  inCurrentSprint: boolean;
}

export interface MyTicketsResult {
  items: TicketSummary[];
  /** Display name of the current sprint, when one could be detected. */
  currentSprintName?: string;
  /** ISO timestamp of the fetch that produced these items. */
  fetchedAt: string;
}

/** Stable key per tracker vendor — storage keys, telemetry, registry lookup. */
export type TrackerKind = 'ado' | 'jira';
