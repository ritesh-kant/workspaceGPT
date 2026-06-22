import type {
  ConfigAction,
  ConfigTargetId,
  ConfigVarDiff,
  DesiredConfigVar,
  PlanSummary,
} from '../types';

/**
 * A policy that can escalate a routine `update` to a `conflict`, forcing human
 * acknowledgement before the change is applied. The default escalates any
 * change to a variable marked `sensitive`.
 *
 * Returning `'update'` keeps it routine; returning `'conflict'` escalates.
 * Only ever called when the variable exists and the value differs.
 */
export type ConflictPolicy = (v: DesiredConfigVar, current: string) => 'update' | 'conflict';

export const defaultConflictPolicy: ConflictPolicy = (v) =>
  v.sensitive ? 'conflict' : 'update';

/** Classify a single variable against its live value. Pure. */
export function classify(
  desired: DesiredConfigVar,
  current: string | null,
  policy: ConflictPolicy = defaultConflictPolicy,
): ConfigAction {
  if (current === null) return 'add';
  if (current === desired.value) return 'match';
  return policy(desired, current);
}

/** Live values, keyed by target id then variable name. */
export type CurrentStateByTarget = Map<ConfigTargetId, Map<string, string>>;

function lookup(current: CurrentStateByTarget, target: ConfigTargetId, key: string): string | null {
  const t = current.get(target);
  if (!t) return null;
  return t.has(key) ? (t.get(key) as string) : null;
}

/**
 * Compute the per-variable diff of desired state against live state.
 *
 * `current` holds what each target reports right now. A target absent from the
 * map is treated as "everything missing" (all `add`) — callers should only pass
 * targets they actually read, so a failed read is never mistaken for empty.
 */
export function computeDiff(
  desired: DesiredConfigVar[],
  current: CurrentStateByTarget,
  policy: ConflictPolicy = defaultConflictPolicy,
): ConfigVarDiff[] {
  return desired.map((v) => {
    const live = lookup(current, v.target, v.key);
    return {
      key: v.key,
      target: v.target,
      current: live,
      desired: v.value,
      action: classify(v, live, policy),
      sensitive: v.sensitive ?? false,
      note: v.note,
    };
  });
}

/** Tally a diff into the summary counts shown as chips in the UI. */
export function summarize(diff: ConfigVarDiff[]): PlanSummary {
  const summary: PlanSummary = { add: 0, update: 0, match: 0, conflict: 0, total: diff.length };
  for (const d of diff) summary[d.action]++;
  return summary;
}

/**
 * The rows the apply step is allowed to touch: `add` and `update` only.
 * `match` is a no-op and `conflict` must be resolved/acknowledged first — both
 * are excluded here so apply can never silently overwrite a conflict.
 */
export function applicableChanges(diff: ConfigVarDiff[]): ConfigVarDiff[] {
  return diff.filter((d) => d.action === 'add' || d.action === 'update');
}

/** True when every conflict has been removed/acknowledged — gates approval. */
export function hasUnresolvedConflicts(diff: ConfigVarDiff[]): boolean {
  return diff.some((d) => d.action === 'conflict');
}
