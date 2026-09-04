/**
 * Scripted model turns for the ticket evals' `--mock` mode.
 *
 * These are not an imitation of how a model thinks. Each script is written to
 * drive one specific harness mechanism through the REAL worker, so that a
 * mechanism which silently stopped working would fail here:
 *
 *   t1 — `explore` runs a real read-only sub-loop (P3); the commit nudge
 *        reaches the model after a root-cause narration (P2); an oldString
 *        copied WITH read_file's "12→" prefixes still applies (P4); the
 *        verification path runs the suite (pre-existing).
 *   t2 — a "## No change needed" ending survives the gate chain with zero
 *        writes, in both profiles (P5).
 *   t3 — a "## Blocked" ending delivered IN-LOOP is accepted, so P2's
 *        structural exit did not make legitimate blocking impossible.
 *
 * The t1 edits are deliberately written with line-number prefixes on
 * oldString/newString. That is the mistake a model makes after P4 numbered
 * read output, and the harness is supposed to absorb it — if the stripper
 * regressed, t1's edits stop applying and its suite stops passing.
 */

/** t1's fix, as three edits the harness must accept prefix-first. */
const T1_STORAGE_OLD = [
  '15→module.exports = { setReuploadRecord, getReuploadRecord, _resetAll };',
].join('\n');
const T1_STORAGE_NEW = [
  '15→function clearReuploadRecord(lineItemId, imageId) {',
  '16→  records.delete(`${lineItemId}::${imageId}`);',
  '17→}',
  '18→',
  '19→module.exports = { setReuploadRecord, getReuploadRecord, clearReuploadRecord, _resetAll };',
].join('\n');

const T1_MAPPER_OLD = [
  "1→const { getReuploadRecord } = require('./storage');",
].join('\n');
const T1_MAPPER_NEW = [
  "1→const { getReuploadRecord, clearReuploadRecord } = require('./storage');",
].join('\n');

const T1_MAPPER_GUARD_OLD = [
  '9→  const record = getReuploadRecord(lineItemId, image.imageId);',
  '10→  if (image.status === IMAGE_REJECTED && record) {',
].join('\n');
const T1_MAPPER_GUARD_NEW = [
  '9→  const record = getReuploadRecord(lineItemId, image.imageId);',
  '10→  if (record && image.status !== IMAGE_REJECTED) {',
  '11→    clearReuploadRecord(lineItemId, image.imageId);',
  '12→    return { ...image };',
  '13→  }',
  '14→  if (image.status === IMAGE_REJECTED && record) {',
].join('\n');

const ungate = (file) => ({
  name: 'edit_file',
  args: {
    path: `src/${file}.js`,
    oldString: '  if (image.status !== IMAGE_REJECTED) return { ...image };\n  return mapImageStatus(lineItemId, image);',
    newString: '  return mapImageStatus(lineItemId, image);',
  },
});

export const MOCK_SCRIPTS = {
  // Claims a full fix, touches nothing. The harness note is appended where
  // the model cannot see or rephrase it, so this asserts the floor: a run
  // that lies about its work is labelled as such before the user reads it.
  f1: {
    explore: [{ finalContent: '{"claims":[],"entryPoints":[],"unknowns":[]}' }],
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/price.js' } }] },
      {
        finalContent:
          '## ✅ Done — the cart summary now rounds to whole dollars\n\n' +
          '### Acceptance criteria\n| Criterion | Verdict | Evidence |\n|---|---|---|\n' +
          '| Rounds to whole dollars | ✅ Met | `src/cartSummary.js:14` |\n\n' +
          '### Changes\n- `src/cartSummary.js` — switched the formatter to `Math.round`.\n\n' +
          '### Verification\n- ✅ `node test.js` — 3 passed\n',
      },
    ],
  },

  t1: {
    // The sub-agent's own turns: one read, then cited claims. Proves the
    // sub-loop executes tools and that its report — not its file contents —
    // is what reaches the caller.
    explore: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/statusMapper.js' } }] },
      {
        finalContent:
          '{"claims":[{"fact":"mapImageStatus masks a rejection whenever a storage record exists, and never clears it","file":"src/statusMapper.js","lines":"7-15"}],' +
          '"entryPoints":[{"symbol":"mapImageStatus","file":"src/statusMapper.js","line":8}],"unknowns":[]}',
      },
    ],
    main: [
      // 1. Delegate the survey rather than reading four call sites.
      {
        content: 'Four mappers funnel into one shared function; I will delegate the survey.',
        toolCalls: [{ name: 'explore', args: { question: 'which mapper decides the displayed image status, and which call sites reach it?', scope: 'src/' } }],
      },
      // 2. Read what the fix touches — several reads in ONE turn, which is
      //    what the read_file description now tells the model to do.
      {
        toolCalls: [
          { name: 'read_file', args: { path: 'src/statusMapper.js' } },
          { name: 'read_file', args: { path: 'src/storage.js' } },
        ],
      },
      // 3. Narrate the root cause while still calling tools — this is what
      //    the commit nudge watches for. Every call site is read here too:
      //    the read-before-edit guard intercepts an edit to a file this run
      //    has not opened, so batching the reads is load-bearing, not style.
      {
        content:
          'Now I have a complete understanding. The fix needs to clear the stored record once the backend reports any non-rejected status.',
        toolCalls: [
          { name: 'read_file', args: { path: 'src/mapB2BLogo.js' } },
          { name: 'read_file', args: { path: 'src/mapMonochromeLogo.js' } },
          { name: 'read_file', args: { path: 'src/mapAdvancedCustomization.js' } },
        ],
      },
      // 4. Every edit in one turn, prefixes left on oldString/newString.
      {
        toolCalls: [
          { name: 'edit_file', args: { path: 'src/storage.js', oldString: T1_STORAGE_OLD, newString: T1_STORAGE_NEW } },
          { name: 'edit_file', args: { path: 'src/statusMapper.js', oldString: T1_MAPPER_OLD, newString: T1_MAPPER_NEW } },
          { name: 'edit_file', args: { path: 'src/statusMapper.js', oldString: T1_MAPPER_GUARD_OLD, newString: T1_MAPPER_GUARD_NEW } },
          ungate('mapB2BLogo'),
          ungate('mapMonochromeLogo'),
          ungate('mapAdvancedCustomization'),
        ],
      },
      // 9-10. Verify.
      { toolCalls: [{ name: 'get_diagnostics', args: {} }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'node test.js' } }] },
      // 11. Report.
      {
        finalContent:
          '## ✅ Done — a second rejection shows its section and its new codes again\n\n' +
          '### Acceptance criteria\n| Criterion | Verdict | Evidence |\n|---|---|---|\n' +
          '| Rejection section returns after a second rejection | ✅ Met | `node test.js` — all tests passed |\n' +
          '| New rejection codes survive | ✅ Met | `src/statusMapper.js:9-14` |\n' +
          '| Optimistic under-review still appears | ✅ Met | `node test.js` — all tests passed |\n' +
          '| All four image types | ✅ Met | `src/mapB2BLogo.js`, `src/mapMonochromeLogo.js`, `src/mapAdvancedCustomization.js` |\n\n' +
          '### Changes\n' +
          '- `src/storage.js` — added `clearReuploadRecord`.\n' +
          '- `src/statusMapper.js` — clears the record once the backend reports a non-rejected status.\n' +
          '- `src/map{B2BLogo,MonochromeLogo,AdvancedCustomization}.js` — dropped the pre-filter that skipped the shared mapper.\n\n' +
          '### Verification\n- ✅ `node test.js` — all tests passed\n- ✅ Diagnostics — 0 problems\n',
      },
    ],
  },

  t2: {
    explore: [{ finalContent: '{"claims":[],"entryPoints":[],"unknowns":[]}' }],
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/price.js' } }] },
      { toolCalls: [{ name: 'run_command', args: { command: 'node test.js' } }] },
      {
        finalContent:
          '## ✅ No change needed — the formatter already renders two decimals\n\n' +
          '### Acceptance criteria\n| Criterion | Verdict | Evidence |\n|---|---|---|\n' +
          '| formatPrice always renders two decimals | ✅ Met | `src/price.js:3` uses `toFixed(2)`; `node test.js` — all tests passed |\n\n' +
          '### Verification\n- ✅ `node test.js` — all tests passed\n',
      },
    ],
  },

  t3: {
    explore: [{ finalContent: '{"claims":[],"entryPoints":[],"unknowns":[]}' }],
    main: [
      { toolCalls: [{ name: 'read_file', args: { path: 'src/badge.js' } }] },
      {
        finalContent:
          '## 🚫 Blocked — the two acceptance criteria cannot both hold\n\n' +
          'Criterion 1 requires the badge to "ALWAYS display the original list price with a strike-through, ' +
          'on every product, including products that are not on sale". Criterion 2 requires it to "NEVER ' +
          'display any price higher than the price the shopper will pay". For a product that is not on sale ' +
          'the list price IS the price paid, so criterion 1 demands showing a struck-through price that ' +
          'criterion 2 forbids. No default resolves this; product has to choose which rule wins.\n\n' +
          '### Acceptance criteria\n| Criterion | Verdict | Evidence |\n|---|---|---|\n' +
          '| Always show struck-through list price | ❌ Not met | conflicts with criterion 2 |\n' +
          '| Never show a price above what is paid | ❌ Not met | conflicts with criterion 1 |\n',
      },
    ],
  },
};
