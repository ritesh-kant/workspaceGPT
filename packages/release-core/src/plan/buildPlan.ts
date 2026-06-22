import type {
  ConfigTarget,
  DesiredConfigVar,
  Environment,
  ReleasePlan,
} from '../types';
import {
  computeDiff,
  summarize,
  type ConflictPolicy,
  type CurrentStateByTarget,
  defaultConflictPolicy,
} from './diff';

export interface BuildPlanInput {
  release: string;
  environment: Environment;
  desired: DesiredConfigVar[];
  /** The targets to read live state from — only the ones referenced by `desired`. */
  targets: ConfigTarget[];
  /** ISO-8601 timestamp; injected by the caller so the logic stays pure/testable. */
  now: string;
  source?: string;
  policy?: ConflictPolicy;
}

/**
 * Resolve live state from each target, diff against desired, and assemble the
 * reviewable {@link ReleasePlan}. Reads only — applies nothing.
 *
 * Targets are read concurrently; a target that throws propagates, so a failed
 * read surfaces as an error rather than being silently treated as "empty"
 * (which would mis-classify everything as `add`).
 */
export async function buildPlan(input: BuildPlanInput): Promise<ReleasePlan> {
  const { release, environment, desired, targets, now, source } = input;
  const policy = input.policy ?? defaultConflictPolicy;

  const referenced = new Set(desired.map((v) => v.target));
  const used = targets.filter((t) => referenced.has(t.id));

  const current: CurrentStateByTarget = new Map();
  await Promise.all(
    used.map(async (t) => {
      current.set(t.id, await t.readCurrent(environment));
    }),
  );

  const configVars = computeDiff(desired, current, policy);

  return {
    release,
    environment,
    generatedAt: now,
    source,
    configVars,
    summary: summarize(configVars),
  };
}
