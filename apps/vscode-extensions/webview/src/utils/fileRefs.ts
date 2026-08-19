export interface FileRef {
  path: string;
  line?: number;
  endLine?: number;
}

const FILE_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|' +
  'json|ya?ml|toml|ini|env|md|mdx|txt|sql|sh|bash|zsh|css|scss|less|html?|' +
  'vue|svelte|tf|tfvars|graphql|proto|xml|gradle';

const FILE_REF_RE = new RegExp(
  `^([\\w.@$-]+(?:/[\\w.@$-]+)+\\.(?:${FILE_EXTENSIONS}))(?:[:#]L(\\d+)(?:[-–]L?(\\d+))?)?$`,
  'i'
);

/**
 * Recognizes a workspace-relative file path inline in model prose, optionally
 * with a `:L#-L#` / `#L#-L#` range, e.g. `terraform/lambda.tf:L69-L106`.
 * Requires a slash + known extension so plain identifiers (`pricePerEach`,
 * `index.handler`) don't get mistaken for files.
 */
export function parseFileRef(text: string): FileRef | null {
  const match = FILE_REF_RE.exec(text.trim());
  if (!match) return null;
  const [, path, line, endLine] = match;
  return {
    path,
    line: line ? parseInt(line, 10) : undefined,
    endLine: endLine ? parseInt(endLine, 10) : undefined,
  };
}
