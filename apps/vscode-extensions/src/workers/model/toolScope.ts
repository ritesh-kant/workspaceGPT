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
  /** Confluence is authenticated: `search_docs`, `get_confluence_page`. */
  confluence: boolean;
  /** Azure DevOps is authenticated: `search_tickets`, `get_ticket`. */
  ado: boolean;
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
  search_tickets: 'ado',
  get_ticket: 'ado',
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
