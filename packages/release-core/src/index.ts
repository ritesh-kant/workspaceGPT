export type {
  Environment,
  ConfigTargetId,
  ConfigAction,
  DesiredConfigVar,
  DesiredState,
  ConfigVarDiff,
  PlanSummary,
  ReleasePlan,
  ResolvedRelease,
  ReleaseSource,
  ConfigTarget,
  ApplyResult,
  VcsProvider,
  TicketProvider,
  CommitRef,
  AuditEntry,
  AuditLog,
} from './types';

export {
  classify,
  computeDiff,
  summarize,
  applicableChanges,
  hasUnresolvedConflicts,
  defaultConflictPolicy,
  type ConflictPolicy,
  type CurrentStateByTarget,
} from './plan/diff';

export { buildPlan, type BuildPlanInput } from './plan/buildPlan';
export { applyPlan, type ApplyPlanInput, type ApplyPlanOutcome } from './apply/applyPlan';

export { InMemoryAuditLog } from './audit/auditLog';
export { FileAuditLog } from './audit/fileAuditLog';
