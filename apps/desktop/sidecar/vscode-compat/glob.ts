/**
 * VS Code-flavoured glob → RegExp: `**` spans directories, `*` and `?` stay
 * within one segment, `{a,b}` alternation, `[...]` classes. Paths are matched
 * with forward slashes, relative to their workspace folder.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '';
  let inClass = false;
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (inClass) {
      if (c === ']') inClass = false;
      re += c === '\\' ? '\\\\' : c;
      continue;
    }
    switch (c) {
      case '*':
        if (glob[i + 1] === '*') {
          // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
          const slash = glob[i + 2] === '/';
          re += slash ? '(?:[^/]*/)*' : '.*';
          i += slash ? 2 : 1;
        } else {
          re += '[^/]*';
        }
        break;
      case '?':
        re += '[^/]';
        break;
      case '[':
        inClass = true;
        re += glob[i + 1] === '!' ? (i++, '[^') : '[';
        break;
      case '{':
        braceDepth++;
        re += '(?:';
        break;
      case '}':
        if (braceDepth > 0) {
          braceDepth--;
          re += ')';
        } else re += '\\}';
        break;
      case ',':
        re += braceDepth > 0 ? '|' : ',';
        break;
      default:
        re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  cache.set(glob, compiled);
  return compiled;
}

export function matchesGlob(relPath: string, glob: string): boolean {
  return globToRegExp(glob.replace(/^\.\//, '')).test(relPath);
}
