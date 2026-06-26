import type {
  ActionContext,
  ActionOutcome,
  ActionPlan,
  ConfigTarget,
  ConfigVarDiff,
  PipelineAction,
} from '../types';
import { buildPlan } from '../plan/buildPlan';

/**
 * Adapts any convergent {@link ConfigTarget} (Vercel, SSM, a repo file, …) to
 * the uniform {@link PipelineAction} interface. The action reads live state,
 * diffs it against the desired config for its target, and applies the approved
 * changes — the standard converge-to-desired model that covers rolling,
 * recreate, GitOps and feature-flag pushes.
 *
 * Triggered/async targets (e.g. a workflow-dispatch promotion) implement
 * {@link PipelineAction} directly instead of going through this wrapper.
 */
export class ConvergentDeployAction implements PipelineAction {
  readonly category = 'deploy' as const;

  constructor(private readonly target: ConfigTarget) {}

  get id(): string {
    return this.target.id;
  }

  async plan(ctx: ActionContext): Promise<ActionPlan> {
    const desired = (ctx.desired ?? []).filter((v) => v.target === this.target.id);
    const plan = await buildPlan({
      release: ctx.release,
      environment: ctx.environment,
      desired,
      targets: [this.target],
      now: ctx.now,
    });
    return { actionId: this.id, category: this.category, plan };
  }

  async apply(_ctx: ActionContext, approved: ConfigVarDiff[] = []): Promise<ActionOutcome> {
    const mine = approved.filter((c) => c.target === this.target.id);
    if (mine.length === 0) {
      return { actionId: this.id, status: 'skipped', results: [] };
    }
    const results = await this.target.apply(_ctx.environment, mine);
    const status = results.some((r) => r.status === 'failed') ? 'failed' : 'applied';
    return { actionId: this.id, status, results };
  }
}
