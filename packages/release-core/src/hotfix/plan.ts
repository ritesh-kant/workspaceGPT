/**
 * release-core — hotfix planning (organisation-agnostic).
 *
 * The hotfix flow reuses the same resolve → extract → diff → approve → apply
 * spine as config-sync, but the unit of work is *tickets → commits → components
 * → tags* instead of config variables. See §9 of DEPLOYMENT-AUTOMATION-DESIGN.md.
 *
 * Everything here is pure: the caller (an adapter) fetches commits from the VCS
 * and passes them in; this module decides which component each commit belongs
 * to, what hotfix number and tag each component gets, and assembles a reviewable
 * {@link HotfixPlan}. Nothing here touches the network or wall-clock time.
 */

import type { CommitRef } from '../types';

/** A hotfix ticket reference (e.g. `D2C-123456`) once normalised. */
export interface HotfixTicket {
  id: string;
  title?: string;
}

/** A commit found for a ticket, annotated with the ticket that surfaced it. */
export interface HotfixCommit extends CommitRef {
  /** The ticket id this commit was found under. */
  ticket: string;
}

/**
 * One component to be hotfixed: the commits to cherry-pick (in the order given),
 * the base released version, the next hotfix ordinal, and the tag to push.
 */
export interface HotfixComponent {
  component: string;
  /** Commits targeting this component, oldest-first (cherry-pick order). */
  commits: HotfixCommit[];
  /** Current released `vX.Y.Z` for this component, when known. */
  baseVersion?: string;
  /** The next `hotfix.N` ordinal for this component (1-based). */
  hotfixNumber: number;
  /**
   * The tag to push, e.g. `api-v1.2.3-hotfix.1`. `null` when the base version
   * is unknown — the reviewer must supply it before applying.
   */
  tag: string | null;
}

export interface HotfixPlanSummary {
  tickets: number;
  commits: number;
  components: number;
  /** Commits found but not attributable to any component. */
  unassigned: number;
}

/**
 * The normalised, reviewable hotfix artifact — the analogue of {@link
 * ReleasePlan} for the hotfix flow. Everything upstream parses into it;
 * everything downstream (cherry-pick, tag, release) acts from it.
 */
export interface HotfixPlan {
  tickets: HotfixTicket[];
  /** The branch cherry-picks land on, e.g. `hotfix/2026-07-03`. */
  branch: string;
  components: HotfixComponent[];
  /** Commits with no derivable component — surfaced so nothing is dropped silently. */
  unassigned: HotfixCommit[];
  /** ISO-8601; stamped by the caller (kept out of pure logic). */
  generatedAt: string;
  summary: HotfixPlanSummary;
}

/** A ticket paired with the commits an adapter found for it. */
export interface HotfixCommitGroup {
  ticket: HotfixTicket;
  commits: CommitRef[];
}

export interface BuildHotfixPlanInput {
  /** Commits found per ticket (fetched by the VCS adapter). */
  groups: HotfixCommitGroup[];
  /** The cherry-pick branch name. */
  branch: string;
  /** ISO-8601 timestamp; injected so the logic stays pure/testable. */
  now: string;
  /**
   * Tag template with `{component}`, `{version}`, `{n}` placeholders. Defaults to
   * {@link DEFAULT_HOTFIX_TAG_TEMPLATE}. `{version}` receives the base version
   * with a single leading `v` ensured.
   */
  tagTemplate?: string;
  /** Current released base version per component (drives the tag's `vX.Y.Z`). */
  baseVersions?: Record<string, string>;
  /**
   * Hotfix ordinals already taken per component (e.g. from existing tags). The
   * next ordinal is `max(existing) + 1`, or 1 when none. */
  existingHotfixNumbers?: Record<string, number[]>;
  /**
   * Map a commit to its component. Defaults to the Conventional-Commit scope
   * (`feat(mms-bff): …` → `mms-bff`). Return `undefined` to leave a commit
   * unassigned.
   */
  componentFor?: (commit: CommitRef) => string | undefined;
}

/**
 * Generic default tag template — semver + hotfix ordinal, no org-specific prefix.
 * Organisations layer their own convention on top (e.g. a scoped `myorg/…`
 * prefix) by passing their own template; this stays org-agnostic so the core
 * carries no org strings.
 */
export const DEFAULT_HOTFIX_TAG_TEMPLATE = '{component}-v{version}-hotfix.{n}';

/** Parsed Conventional-Commit header, or null when the title doesn't match. */
export interface ConventionalCommit {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
}

// type(scope)!: description  — scope and the breaking `!` are optional.
const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;

/** Parse a commit title as a Conventional Commit. Returns null if it doesn't conform. */
export function parseConventionalCommit(title: string): ConventionalCommit | null {
  const m = CONVENTIONAL_RE.exec(title.trim());
  if (!m) return null;
  return {
    type: m[1],
    scope: m[2]?.trim() || undefined,
    breaking: m[3] === '!',
    description: m[4].trim(),
  };
}

/**
 * Default commit → component rule: prefer an explicit `commit.component` (an
 * adapter may set it), else the Conventional-Commit scope.
 */
export function defaultComponentFor(commit: CommitRef): string | undefined {
  if (commit.component) return commit.component;
  return parseConventionalCommit(commit.title)?.scope;
}

/** `max(existing) + 1`, or 1 when there are no prior hotfixes. */
export function nextHotfixNumber(existing?: number[]): number {
  if (!existing || existing.length === 0) return 1;
  return Math.max(...existing) + 1;
}

/** Ensure exactly one leading `v` on a version string (`1.2.3` → `v1.2.3`). */
function ensureV(version: string): string {
  const t = version.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

/**
 * Render a hotfix tag, or null when the base version is unknown (the reviewer
 * must fill it in — we never invent a version).
 */
export function formatHotfixTag(
  template: string,
  component: string,
  baseVersion: string | undefined,
  hotfixNumber: number,
): string | null {
  if (!baseVersion || !baseVersion.trim()) return null;
  return template
    .replace(/\{component\}/g, component)
    .replace(/\{version\}/g, ensureV(baseVersion).replace(/^v/, ''))
    .replace(/\{n\}/g, String(hotfixNumber));
}

/**
 * Group commits by component, assign the next hotfix ordinal + tag per
 * component, and assemble the reviewable {@link HotfixPlan}. Pure — reads
 * nothing, writes nothing.
 *
 * Commit order within a component follows the order commits appear across the
 * groups (oldest-first is the caller's responsibility), which is the
 * cherry-pick order. Commits that map to no component are collected in
 * `unassigned` so they're never silently dropped.
 */
export function buildHotfixPlan(input: BuildHotfixPlanInput): HotfixPlan {
  const {
    groups,
    branch,
    now,
    tagTemplate = DEFAULT_HOTFIX_TAG_TEMPLATE,
    baseVersions = {},
    existingHotfixNumbers = {},
    componentFor = defaultComponentFor,
  } = input;

  const tickets: HotfixTicket[] = groups.map((g) => g.ticket);

  // Preserve first-seen component order for a stable, reviewable plan.
  const byComponent = new Map<string, HotfixCommit[]>();
  const unassigned: HotfixCommit[] = [];
  let commitCount = 0;

  for (const group of groups) {
    for (const commit of group.commits) {
      commitCount++;
      const hc: HotfixCommit = { ...commit, ticket: group.ticket.id };
      const component = componentFor(commit);
      if (!component) {
        unassigned.push(hc);
        continue;
      }
      const list = byComponent.get(component);
      if (list) list.push(hc);
      else byComponent.set(component, [hc]);
    }
  }

  const components: HotfixComponent[] = [];
  for (const [component, commits] of byComponent) {
    const baseVersion = baseVersions[component];
    const hotfixNumber = nextHotfixNumber(existingHotfixNumbers[component]);
    components.push({
      component,
      commits,
      baseVersion,
      hotfixNumber,
      tag: formatHotfixTag(tagTemplate, component, baseVersion, hotfixNumber),
    });
  }

  return {
    tickets,
    branch,
    components,
    unassigned,
    generatedAt: now,
    summary: {
      tickets: tickets.length,
      commits: commitCount,
      components: components.length,
      unassigned: unassigned.length,
    },
  };
}
