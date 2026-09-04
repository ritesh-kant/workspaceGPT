/**
 * Line-number prefixes for file content shown to the model.
 *
 * Why number at all: the FINAL REPORT FORMAT requires `file.ts:L120-L130`
 * evidence for every acceptance criterion, and an unnumbered read leaves the
 * model counting lines to produce it. It does not count — it estimates, and
 * on ticket #1534774 the follow-up report cited `imageReuploadStorage.ts:31-L34`
 * for a function that was never written. Numbers in the read output make the
 * citation a copy rather than a guess, and let a follow-up read name an exact
 * range instead of re-fetching the whole file.
 *
 * Why the prefix needs a stripper: `edit_file`'s contract is that `oldString`
 * is copied character-for-character out of `read_file` output, and a copied
 * "142→" would never match the file. The existing whitespace-tolerant rescue
 * in agentWriteTools cannot save it either — digits are not whitespace. So
 * the same change that adds the prefix has to remove it deterministically on
 * the way back in, rather than relying on the model to remember (which is
 * exactly the kind of instruction models drop on turn 25).
 */

/**
 * Separator between the number and the line. An arrow rather than a tab: a
 * tab would be indistinguishable from the leading indentation of a
 * tab-indented file, making the prefix ambiguous to strip.
 */
export const LINE_NUMBER_SEP = '→';

/** `^<spaces><digits>→` — the prefix numberLines writes. */
const PREFIX_RE = /^\s*\d+→/;

/**
 * Prefix each line with its 1-based number, right-aligned so the code stays
 * visually aligned.
 *
 * @param content   the file slice, newline-separated
 * @param startLine 1-based number of the slice's FIRST line
 */
export function numberLines(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}${LINE_NUMBER_SEP}${line}`)
    .join('\n');
}

/**
 * Remove numberLines' prefixes, if and only if the text carries them
 * throughout.
 *
 * Conservative by design: every non-blank line must have the prefix before
 * anything is stripped. Source code containing a stray arrow (a comment, a
 * string, a JSX literal) must come through untouched, because this runs on
 * `oldString` — mangling one would turn a correct edit into a failed match,
 * which is worse than the problem it solves.
 */
export function stripLineNumbers(text: string): string {
  const s = String(text ?? '');
  if (!s) return s;
  const lines = s.split('\n');
  const meaningful = lines.filter((l) => l.trim() !== '');
  if (meaningful.length === 0) return s;
  if (!meaningful.every((l) => PREFIX_RE.test(l))) return s;
  return lines.map((l) => l.replace(PREFIX_RE, '')).join('\n');
}

/** Does this text look like numbered read output (i.e. would stripping change it)? */
export function hasLineNumbers(text: string): boolean {
  return stripLineNumbers(text) !== String(text ?? '');
}
