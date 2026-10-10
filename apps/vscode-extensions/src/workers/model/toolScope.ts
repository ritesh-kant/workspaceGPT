/**
 * Which tools a turn is actually offered.
 *
 * TOOL_DEFS used to be sent whole on every request — 27 schemas, ~20k
 * characters, roughly 5k prompt tokens per completion — regardless of whether
 * Confluence or Azure DevOps were connected, or even whether a workspace was
 * open. That cost every turn, and it also invited the model to call
 * `search_docs` against a source that was never configured, get an error back,
 * and waste a round on it.
 *
 * Scoping is decided from FACTS the host can check (folder open, source
 * authenticated), never from the text of the request. A tool that is
 * available is always offered; the model decides whether to use it. The one
 * thing this file must never do is remove an ability because of a guess about
 * what the user meant — that failure mode is documented on #1534774.
 */

export interface ToolAvailability {
  /** A workspace folder is open: file, search, git, diagnostics and write tools work. */
  codebase: boolean;
  /** Confluence is authenticated: `search_docs`, `get_confluence_page`, and the page write tools (which check the write scope themselves). */
  confluence: boolean;
  /** A ticket tracker (Azure DevOps, Jira, …) is authenticated: `search_tickets`, `get_ticket`. See tickets/registry.ts. */
  tickets: boolean;
  /** The WorkspaceGPT Chrome extension is connected to this host right now (services/browser/browserBridge.ts). Optional: a host that predates it offers no browser tools. */
  browser?: boolean;
  /** User memory is switched on (Settings → Memory): offers `save_memory`. */
  memory?: boolean;
}

/**
 * The capability each tool needs. A tool absent from this map is offered
 * unconditionally — today that is only `search_web`, which degrades to a
 * keyless basic search on its own rather than failing.
 */
export const TOOL_REQUIREMENTS: Readonly<Record<string, keyof ToolAvailability>> = {
  search_codebase: 'codebase',
  explore: 'codebase',
  find_symbol: 'codebase',
  find_references: 'codebase',
  go_to_definition: 'codebase',
  read_file: 'codebase',
  list_directory: 'codebase',
  find_files: 'codebase',
  run_command: 'codebase',
  run_checks: 'codebase',
  check_command: 'codebase',
  get_diagnostics: 'codebase',
  git_status: 'codebase',
  git_diff: 'codebase',
  git_log: 'codebase',
  git_blame: 'codebase',
  edit_file: 'codebase',
  create_file: 'codebase',
  delete_file: 'codebase',
  search_docs: 'confluence',
  get_confluence_page: 'confluence',
  find_confluence_location: 'confluence',
  update_confluence_page: 'confluence',
  create_confluence_page: 'confluence',
  save_memory: 'memory',
  search_tickets: 'tickets',
  get_ticket: 'tickets',
  browser_list_tabs: 'browser',
  browser_open_tab: 'browser',
  browser_close_tab: 'browser',
  browser_navigate: 'browser',
  browser_read_page: 'browser',
  browser_read_tree: 'browser',
  browser_screenshot: 'browser',
  browser_act: 'browser',
  browser_eval: 'browser',
  browser_console: 'browser',
  browser_network: 'browser',
};

interface NamedToolDef {
  function: { name: string };
}

/**
 * Filter a tool list down to what `availability` allows.
 *
 * An absent `availability` returns the list untouched — the contract for a
 * host that predates this field, and for harnesses that want the full set.
 */
export function scopeToolDefs<T extends NamedToolDef>(defs: readonly T[], availability?: ToolAvailability): T[] {
  if (!availability) return [...defs];
  return defs.filter((d) => {
    const needs = TOOL_REQUIREMENTS[d.function.name];
    return !needs || availability[needs];
  });
}

/** Tools that change the workspace or Confluence. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'edit_file',
  'create_file',
  'delete_file',
  'update_confluence_page',
  'create_confluence_page',
]);

/**
 * Plan mode's tool list: everything except the writes. The user set the dial
 * to Plan — a fact, like a connected source — so "change nothing this turn" is
 * a capability the run lacks, not a sentence the model is asked to obey.
 * `run_command` stays: outside Agent mode every command is a review card.
 */
export function withoutWriteTools<T extends NamedToolDef>(defs: readonly T[]): T[] {
  return defs.filter((d) => !WRITE_TOOL_NAMES.has(d.function.name));
}

/**
 * The tools a one-click action needs, and nothing else. Keyed by the action the
 * webview says started the turn — the button the user pressed is a fact, like
 * the Plan dial, not a guess from the prompt. A turn the user TYPES never has
 * an action, so anything beyond the button's job is one message away.
 *
 * 'publish-spike' works from the finished spike document: read it, look at the
 * space's existing pages for their format, ask where it goes, create the page.
 * Offering the whole code toolbelt is what let that turn re-scout the repo.
 */
export const TURN_ACTION_TOOL_NAMES: Readonly<Record<'publish-spike', ReadonlySet<string>>> = {
  'publish-spike': new Set([
    'read_file',
    'search_docs',
    'get_confluence_page',
    'find_confluence_location',
    'create_confluence_page',
    'update_confluence_page',
    'get_ticket',
    'ask_user',
  ]),
};

/** `defs` narrowed to what `action` needs; no action leaves the list untouched. */
export function forTurnAction<T extends NamedToolDef>(defs: readonly T[], action?: keyof typeof TURN_ACTION_TOOL_NAMES): T[] {
  const allowed = action ? TURN_ACTION_TOOL_NAMES[action] : undefined;
  return allowed ? defs.filter((d) => allowed.has(d.function.name)) : [...defs];
}
