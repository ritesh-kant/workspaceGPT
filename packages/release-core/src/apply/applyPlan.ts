import type {
  ApplyResult,
  AuditLog,
  ConfigTarget,
  ReleasePlan,
} from '../types';
import { applicableChanges, hasUnresolvedConflicts } from '../plan/diff';

export interface ApplyPlanInput {
  plan: ReleasePlan;
  targets: ConfigTarget[];
  now: string;
  actor?: string;
  audit?: AuditLog;
  /**
   * Caller must have surfaced conflicts to the user and had them acknowledged.
   * Apply refuses to run while unacknowledged conflicts remain unless this is
   * explicitly true — the last line of defence behind the UI gate.
   */
  conflictsAcknowledged?: boolean;
}

export interface ApplyPlanOutcome {
  results: ApplyResult[];
  applied: number;
  failed: number;
}

/**
 * Apply the approved changes in a plan, idempotently. Only `add`/`update` rows
 * are touched; `match` is a no-op and `conflict` is never applied.
 *
 * Each target applies independently — one target failing does not abort the
 * others, so a partial-success result (e.g. 14/15) is a first-class outcome.
 */
export async function applyPlan(input: ApplyPlanInput): Promise<ApplyPlanOutcome> {
  const { plan, targets, now, actor, audit } = input;

  if (hasUnresolvedConflicts(plan.configVars) && !input.conflictsAcknowledged) {
    throw new Error(
      'Refusing to apply: plan has unresolved conflicts that were not acknowledged.',
    );
  }

  const changes = applicableChanges(plan.configVars);
  const byTarget = new Map<string, typeof changes>();
  for (const c of changes) {
    const list = byTarget.get(c.target) ?? [];
    list.push(c);
    byTarget.set(c.target, list);
  }

  await audit?.record({
    at: now,
    release: plan.release,
    environment: plan.environment,
    action: 'approved',
    actor,
    detail: `${changes.length} change(s) approved`,
  });

  const perTarget = await Promise.all(
    [...byTarget.entries()].map(async ([targetId, list]) => {
      const target = targets.find((t) => t.id === targetId);
      if (!target) {
        return list.map<ApplyResult>((c) => ({
          key: c.key,
          target: targetId,
          status: 'failed',
          error: `No configured target for "${targetId}"`,
        }));
      }
      try {
        return await target.apply(plan.environment, list);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return list.map<ApplyResult>((c) => ({
          key: c.key,
          target: targetId,
          status: 'failed',
          error: msg,
        }));
      }
    }),
  );

  const results = perTarget.flat();

  for (const r of results) {
    await audit?.record({
      at: now,
      release: plan.release,
      environment: plan.environment,
      action: r.status === 'failed' ? 'failed' : r.status === 'skipped' ? 'skipped' : 'applied',
      target: r.target,
      key: r.key,
      actor,
      detail: r.error ?? r.reference,
    });
  }

  return {
    results,
    applied: results.filter((r) => r.status === 'applied').length,
    failed: results.filter((r) => r.status === 'failed').length,
  };
}
