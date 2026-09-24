/**
 * The chat view's title-bar buttons (New Chat, History, Settings, …).
 *
 * In VS Code these aren't in the webview at all — they are
 * `contributes.menus["view/title"]` entries the workbench draws above it, and
 * Settings is only reachable that way. The desktop reads the same
 * package.json entries, evaluates their `when` clauses against the context
 * keys the extension sets, and the bridge draws them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TitleAction {
  command: string;
  title: string;
  iconLight?: string;
  iconDark?: string;
}

/**
 * Title actions that make no sense in a window that already is the chat.
 * Listed, not silently dropped: each one here is a decision.
 */
const HIDDEN_IN_DESKTOP: Record<string, string> = {
  'workspacegpt.openChatInEditor': 'the desktop window already shows the chat full-size (createWebviewPanel is NotSupported)',
};

/** Enough of VS Code's `when` grammar for these menus: `a == b`, `a != b`, `!a`, `a`, `&&`, `||`. */
export function evaluateWhen(expr: string | undefined, keys: Map<string, unknown>): boolean {
  if (!expr) return true;
  return expr.split('||').some((clause) =>
    clause.split('&&').every((raw) => {
      const term = raw.trim();
      const eq = /^([\w.]+)\s*(==|!=)\s*['"]?([\w.-]+)['"]?$/.exec(term);
      if (eq) {
        const value = String(keys.get(eq[1]!) ?? '');
        return eq[2] === '==' ? value === eq[3] : value !== eq[3];
      }
      if (term.startsWith('!')) return !keys.get(term.slice(1).trim());
      return !!keys.get(term);
    })
  );
}

export function computeTitleActions(extensionDir: string, viewId: string, contextKeys: Map<string, unknown>): TitleAction[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
  const commands = new Map<string, any>((pkg.contributes?.commands ?? []).map((c: any) => [c.command, c]));
  const keys = new Map(contextKeys);
  keys.set('view', viewId);
  const iconUrl = (rel: unknown) => (typeof rel === 'string' && !rel.startsWith('$(') ? `/_res${encodeURI(path.join(extensionDir, rel))}` : undefined);
  return (pkg.contributes?.menus?.['view/title'] ?? [])
    .filter((m: any) => String(m.group ?? '').startsWith('navigation'))
    .filter((m: any) => !(m.command in HIDDEN_IN_DESKTOP) && evaluateWhen(m.when, keys))
    .sort((a: any, b: any) => String(a.group).localeCompare(String(b.group), undefined, { numeric: true }))
    .map((m: any): TitleAction => {
      const c = commands.get(m.command) ?? {};
      return {
        command: m.command,
        title: String(c.title ?? m.command).replace(/^WorkspaceGPT:\s*/, ''),
        // VS Code's naming: the "light" icon is the one drawn on a light theme (dark glyph).
        iconLight: iconUrl(c.icon?.light),
        iconDark: iconUrl(c.icon?.dark),
      };
    });
}
