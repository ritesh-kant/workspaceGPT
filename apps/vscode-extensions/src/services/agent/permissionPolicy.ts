import { hasAutonomousShellPlumbing, isAutonomousSafeCommand } from './commandTools';

/**
 * The composer's permission dial (docs/design/permission-modes.md).
 *
 * - manual: every file change, command and Confluence write waits on a review card.
 * - auto:   workspace edits and verification commands run on their own
 *           (checkpointed, audited); anything riskier gets a card.
 * - full:   nothing waits for a card.
 *
 * Plan is not a level: it is `planMode`, which offers no write tools at all.
 *
 * The hard command denylist (assertCommandAllowed) runs before any of this and
 * holds at every level, Full included.
 */
export type Permission = 'manual' | 'auto' | 'full';

export const PERMISSIONS: readonly Permission[] = ['manual', 'auto', 'full'];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * The permission a send carries. `permission` wins; the pre-dial `autonomous`
 * boolean (an older webview, the My Work ▶ button) means Auto, and neither
 * means Manual.
 */
export function resolvePermission(permission: unknown, autonomous: boolean): Permission {
  if (isPermission(permission)) return permission;
  return autonomous ? 'auto' : 'manual';
}

export type PermissionAction =
  | { kind: 'file-write' }
  | { kind: 'command'; command: string }
  | { kind: 'confluence-write' };

/** `card`: park on a review card. `refuse`: never run, tell the model why. */
export type PermissionDecision = 'auto' | 'card' | 'refuse';

/**
 * A command that is not positively known to be safe gets a card, so a miss in
 * the classifier costs a click and never a capability. It reads commands the
 * model produced, not the user's text.
 */
export function decide(permission: Permission, action: PermissionAction): PermissionDecision {
  if (permission === 'full') return 'auto';
  switch (action.kind) {
    case 'file-write':
      return permission === 'auto' ? 'auto' : 'card';
    case 'command':
      if (permission === 'manual') return 'card';
      if (isAutonomousSafeCommand(action.command)) return 'auto';
      return hasAutonomousShellPlumbing(action.command) ? 'refuse' : 'card';
    case 'confluence-write':
      return 'card';
  }
}
