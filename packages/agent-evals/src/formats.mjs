/**
 * The three candidate edit formats for Phase 0.1.
 *
 * Each format = { id, instructions, parse, apply }:
 *  - instructions: the system-prompt section telling the model how to emit edits
 *  - parse(text) -> edits[]            (throws EvalError('parse', …) on garbage)
 *  - apply(edits, files) -> newFiles   (throws EvalError('apply', …) when an
 *                                       edit can't be located/applied)
 *
 * `files` is a plain { [path]: content } map — the harness never touches disk.
 */

export class EvalError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage; // 'parse' | 'apply'
  }
}

// ── 1. search/replace blocks (Aider-style) ─────────────────────────────────

const searchReplace = {
  id: 'search-replace',
  instructions: `Emit every change as one or more SEARCH/REPLACE blocks, nothing else.

Format of one block (the marker lines must match exactly):

path/to/file.ts
<<<<<<< SEARCH
lines copied EXACTLY from the current file (with original indentation)
=======
the replacement lines
>>>>>>> REPLACE

Rules:
- The SEARCH text must be an exact, contiguous excerpt of the current file — copy it character-for-character.
- Include enough surrounding lines that the SEARCH text appears exactly once in the file.
- To insert code, include a neighboring line in SEARCH and repeat it in REPLACE alongside the new code.
- To delete code, leave the REPLACE section empty.
- To create a new file, use its path with an empty SEARCH section; REPLACE is the full file content.
- Use several small blocks rather than one big one. Never abbreviate with "..." or comments like "rest unchanged".`,

  parse(text) {
    const re = /^([^\n<>=]+?)\s*\n<{7} SEARCH\n([\s\S]*?)={7}\n([\s\S]*?)>{7} REPLACE/gm;
    const edits = [];
    for (const m of text.matchAll(re)) {
      const strip = (s) => (s === '' ? '' : s.replace(/\n$/, ''));
      edits.push({
        path: m[1].trim().replace(/^[#*`\s]+|[`\s]+$/g, ''),
        search: strip(m[2]),
        replace: strip(m[3]),
      });
    }
    if (edits.length === 0) throw new EvalError('parse', 'no SEARCH/REPLACE blocks found');
    return edits;
  },

  apply(edits, files) {
    const out = { ...files };
    for (const e of edits) {
      if (e.search === '') {
        if (out[e.path] !== undefined) throw new EvalError('apply', `create on existing file ${e.path}`);
        out[e.path] = e.replace + '\n';
        continue;
      }
      const content = out[e.path];
      if (content === undefined) throw new EvalError('apply', `unknown file ${e.path}`);
      const count = content.split(e.search).length - 1;
      if (count === 0) throw new EvalError('apply', `SEARCH text not found in ${e.path}`);
      if (count > 1) throw new EvalError('apply', `SEARCH text ambiguous (${count}×) in ${e.path}`);
      out[e.path] = content.replace(e.search, e.replace);
    }
    return out;
  },
};

// ── 2. unified diff ─────────────────────────────────────────────────────────

const unifiedDiff = {
  id: 'unified-diff',
  instructions: `Emit every change as a unified diff inside a single \`\`\`diff fenced block, nothing else.

Rules:
- Standard format: "--- a/path", "+++ b/path", hunks starting with @@.
- Line numbers in @@ headers may be approximate — context lines are what must be exact. Copy context lines character-for-character from the current file.
- Give each hunk at least 2 unchanged context lines around the changes so it can be located unambiguously.
- To create a new file use "--- /dev/null" and "+++ b/path" with every line prefixed "+".
- Never abbreviate with "..." — every context line must be real file content.`,

  parse(text) {
    const body = [...text.matchAll(/```(?:diff)?\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n') || text;
    const lines = body.split('\n');
    const edits = []; // { path, oldPath, hunks: [{ old: [], new: [] }] }
    let cur = null;
    let hunk = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('--- ')) {
        const oldPath = l.slice(4).trim().replace(/^a\//, '');
        const nextLine = lines[i + 1] ?? '';
        if (!nextLine.startsWith('+++ ')) throw new EvalError('parse', '--- without +++');
        const newPath = nextLine.slice(4).trim().replace(/^b\//, '');
        cur = { path: newPath, oldPath, hunks: [] };
        edits.push(cur);
        hunk = null;
        i++;
      } else if (l.startsWith('@@')) {
        if (!cur) throw new EvalError('parse', '@@ before file header');
        hunk = { old: [], new: [] };
        cur.hunks.push(hunk);
      } else if (hunk && (l.startsWith(' ') || l === '')) {
        hunk.old.push(l.slice(1));
        hunk.new.push(l.slice(1));
      } else if (hunk && l.startsWith('-')) {
        hunk.old.push(l.slice(1));
      } else if (hunk && l.startsWith('+')) {
        hunk.new.push(l.slice(1));
      } else if (l.startsWith('\\')) {
        // "\ No newline at end of file" — ignore
      } else {
        hunk = null; // prose between diffs ends the hunk
      }
    }
    if (edits.length === 0 || edits.every((e) => e.hunks.length === 0)) {
      throw new EvalError('parse', 'no diff hunks found');
    }
    return edits;
  },

  apply(edits, files) {
    const out = { ...files };
    for (const e of edits) {
      if (e.oldPath === '/dev/null') {
        if (out[e.path] !== undefined) throw new EvalError('apply', `create on existing file ${e.path}`);
        out[e.path] = e.hunks.flatMap((h) => h.new).join('\n') + '\n';
        continue;
      }
      const content = out[e.path];
      if (content === undefined) throw new EvalError('apply', `unknown file ${e.path}`);
      let lines = content.split('\n');
      for (const h of e.hunks) {
        // trim trailing empty context that models often add
        const oldL = [...h.old];
        while (oldL.length && oldL[oldL.length - 1] === '') oldL.pop();
        if (oldL.length === 0) throw new EvalError('apply', `empty hunk for ${e.path}`);
        const idx = findSequence(lines, oldL);
        if (idx === -1) throw new EvalError('apply', `hunk context not found in ${e.path}`);
        if (findSequence(lines, oldL, idx + 1) !== -1) {
          throw new EvalError('apply', `hunk context ambiguous in ${e.path}`);
        }
        const newL = [...h.new];
        while (newL.length && h.old.length && oldL.length !== h.old.length && newL[newL.length - 1] === '') newL.pop();
        lines = [...lines.slice(0, idx), ...newL, ...lines.slice(idx + oldL.length)];
      }
      out[e.path] = lines.join('\n');
    }
    return out;
  },
};

function findSequence(haystack, needle, from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ── 3. full-file rewrite ────────────────────────────────────────────────────

const fullFile = {
  id: 'full-file',
  instructions: `Emit the COMPLETE new content of every file you change or create, nothing else.

Format for each file: the path on its own line, then a fenced code block with the entire file:

path/to/file.ts
\`\`\`
<the whole file, top to bottom>
\`\`\`

Rules:
- Output the full file even for a one-line change. Never abbreviate, never write "... unchanged ..." or similar — the block replaces the file verbatim.
- Only include files you are changing or creating.`,

  parse(text) {
    const re = /^([^\n`]+?)\s*\n```[a-zA-Z]*\n([\s\S]*?)\n```/gm;
    const edits = [];
    for (const m of text.matchAll(re)) {
      edits.push({ path: m[1].trim().replace(/^[#*`\s]+|[`:\s]+$/g, ''), content: m[2] });
    }
    if (edits.length === 0) throw new EvalError('parse', 'no file blocks found');
    return edits;
  },

  apply(edits, files) {
    const out = { ...files };
    for (const e of edits) {
      if (/\.{3}|unchanged|rest of (the )?file/i.test(e.content) && files[e.path] !== undefined) {
        // crude truncation guard: full-file must not elide
        if (!files[e.path].includes('...')) {
          throw new EvalError('apply', `elision detected in full-file output for ${e.path}`);
        }
      }
      out[e.path] = e.content + '\n';
    }
    return out;
  },
};

export const formats = { 'search-replace': searchReplace, 'unified-diff': unifiedDiff, 'full-file': fullFile };
