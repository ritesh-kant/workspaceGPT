/** Workspace-relative paths in the webview always use `/`. */
const normalizeSlashes = (p: string) => p.replace(/\\/g, '/');

export const fileName = (p: string) => {
  const parts = normalizeSlashes(p).split('/').filter(Boolean);
  return parts[parts.length - 1] || p;
};

/**
 * Full parent directory, not just the last folder. Same basename in
 * `src/components` vs `tests/components` must stay distinguishable without
 * the tooltip.
 */
export const parentDir = (p: string) => {
  const parts = normalizeSlashes(p).split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
};

/** Split at the first dot so the extension survives the name's ellipsis. */
export const splitName = (n: string): [string, string] => {
  const i = n.indexOf('.');
  return i > 0 ? [n.slice(0, i), n.slice(i)] : [n, ''];
};

/** Deleted files have nothing on disk to diff against. */
export const isReviewableDiff = (kind: string) => kind !== 'delete';

export const diffPathsToOpen = (files: { path: string; kind: string }[]): string[] =>
  files.filter((f) => isReviewableDiff(f.kind)).map((f) => f.path);
