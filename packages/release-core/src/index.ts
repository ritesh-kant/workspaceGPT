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
  ActionCategory,
  ActionRef,
  ActionContext,
  ActionPlan,
  ActionOutcome,
  PipelineAction,
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

export { ConvergentDeployAction } from './actions/convergentDeployAction';

export {
  buildHotfixPlan,
  parseConventionalCommit,
  defaultComponentFor,
  nextHotfixNumber,
  formatHotfixTag,
  DEFAULT_HOTFIX_TAG_TEMPLATE,
  type HotfixTicket,
  type HotfixCommit,
  type HotfixComponent,
  type HotfixPlan,
  type HotfixPlanSummary,
  type HotfixCommitGroup,
  type BuildHotfixPlanInput,
  type ConventionalCommit,
} from './hotfix/plan';

export { InMemoryAuditLog } from './audit/auditLog';
export { FileAuditLog } from './audit/fileAuditLog';
