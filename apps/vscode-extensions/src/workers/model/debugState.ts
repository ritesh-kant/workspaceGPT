/**
 * Debug mode's run state (docs/design/debug-mode.md §4).
 *
 * Holds what a debugging run has actually ESTABLISHED, kept outside the
 * model's context so it survives a long run and cannot be talked around:
 *
 *  - evidence: things the run recorded — a failing command, the same command
 *    passing after the fix, a probe's logged values, the fix reverted;
 *  - hypotheses: what the model thinks is wrong, each with the observation it
 *    predicts, resolved only against recorded evidence;
 *  - the proof state: repro red before the fix, green after, red again with
 *    the fix reverted (the counterfactual).
 *
 * A root cause may be called "confirmed" only when this state backs it. The
 * model is the one writing the report, so the check is on what the model says
 * (never on the user's text): a confirmed claim without the proof gets sent
 * back once or twice, then delivered with a visible stamp instead of being
 * blocked — it can only ever add a turn or a label.
 *
 * Pure and vscode-free: unit-tested headlessly, like autoVerify.ts.
 */

export type EvidenceKind = 'repro-fail' | 'repro-pass' | 'probe' | 'counterfactual' | 'note';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  text: string;
}

export type HypothesisStatus = 'open' | 'confirmed' | 'refuted';

export interface Hypothesis {
  id: string;
  text: string;
  /** The observation that would be seen if this is true — what makes it testable. */
  predicts: string;
  status: HypothesisStatus;
  evidence: string[];
  note?: string;
}

export type CounterfactualState = 'red' | 'green' | 'unavailable' | null;

const MAX_HYPOTHESES = 8;
const MAX_EVIDENCE = 60;
const EVIDENCE_TEXT_CHARS = 500;
const EVIDENCE_ID_RE = /\bE\d+\b/g;

/** A path that is a test, not the code under test. */
export function isTestPath(p: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e)\/|[._-](test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i.test(p);
}

export type RootCauseStatus = 'confirmed' | 'probable' | 'not found';

/** A `### Root cause — confirmed` style heading (DEBUG_REPORT_FORMAT). The first one wins. */
const ROOT_CAUSE_HEADING_RE = /^#{1,4}\s*.*root cause.*$/gim;

/** The status the model gave its root cause, or null when it gave none. */
export function claimedRootCauseStatus(answer: string): RootCauseStatus | null {
  // The "### Root cause — …" SECTION is the claim; the status banner ("## ⚠️ Root cause not
  // found …") only summarises the run, so the section wins when both are there.
  const headings = answer.match(ROOT_CAUSE_HEADING_RE) ?? [];
  const heading = headings.find((h) => /^###/.test(h)) ?? headings[0];
  if (!heading) return null;
  if (/not found|no root cause|could not (find|determine)/i.test(heading)) return 'not found';
  if (/probable|likely|suspected|hypothes/i.test(heading)) return 'probable';
  if (/confirmed/i.test(heading)) return 'confirmed';
  return null;
}

export interface CommandResultLike {
  exitCode?: number | null;
  timedOut?: boolean;
  command?: string;
  output?: string;
  /** Host-extracted probe lines (debugProbes.extractProbeLines), with each probe's label. */
  probes?: Record<string, { count: number; samples: string[]; label?: string; path?: string }>;
  cached?: boolean;
}

export class DebugTracker {
  readonly hypotheses: Hypothesis[] = [];
  readonly evidence: Evidence[] = [];
  /** Commands seen failing before any fix landed — candidate repros. */
  private failingCommands = new Map<string, string>();
  private writes = 0;
  private counterfactual: CounterfactualState = null;
  private reproPassId: string | null = null;
  private reproFailId: string | null = null;

  /**
   * A source edit was applied. Probe edits are not writes, and neither is a
   * test file: writing the failing regression test FIRST is the intended flow,
   * and it must not read as "the fix has landed" (which would stop the repro
   * from counting as red-before).
   */
  noteWrite(path?: string): void {
    if (path && isTestPath(path)) return;
    this.writes++;
    // The tree changed, so any earlier "red without the fix" no longer describes it.
    this.counterfactual = null;
  }

  get writeCount(): number {
    return this.writes;
  }

  private addEvidence(kind: EvidenceKind, text: string): Evidence {
    const ev: Evidence = { id: `E${this.evidence.length + 1}`, kind, text: text.slice(0, EVIDENCE_TEXT_CHARS) };
    if (this.evidence.length < MAX_EVIDENCE) this.evidence.push(ev);
    return ev;
  }

  /**
   * A finished `run_command` / `run_checks`. Records the repro states from the
   * exit code and any probe lines — facts from the tool result, never from the
   * model's account of it. Returns the evidence it recorded.
   */
  noteCommand(result: CommandResultLike | null | undefined): Evidence[] {
    if (!result || typeof result !== 'object') return [];
    const recorded: Evidence[] = [];
    const command = (result.command ?? '').trim();
    const exit = result.exitCode;
    if (command && typeof exit === 'number' && !result.timedOut && !result.cached) {
      if (exit !== 0 && this.writes === 0) {
        const tail = String(result.output ?? '').trim().split('\n').slice(-6).join('\n');
        const ev = this.addEvidence('repro-fail', `\`${command}\` failed (exit ${exit})${tail ? `:\n${tail}` : ''}`);
        this.failingCommands.set(command, ev.id);
        this.reproFailId ??= ev.id;
        recorded.push(ev);
      } else if (exit === 0 && this.writes > 0 && this.failingCommands.has(command)) {
        const ev = this.addEvidence('repro-pass', `\`${command}\` passes after the fix (it failed before: ${this.failingCommands.get(command)}).`);
        this.reproPassId = ev.id;
        recorded.push(ev);
      }
    }
    for (const [id, p] of Object.entries(result.probes ?? {})) {
      recorded.push(this.addEvidence('probe', `probe ${id}${p.label ? ` (${p.label})` : ''}${p.path ? ` in ${p.path}` : ''} fired ${p.count}×: ${p.samples.join(' | ')}`));
    }
    return recorded;
  }

  /** The result of the host's `counterfactual_check`. */
  noteCounterfactual(result: { revertedExitCode?: number | null; command?: string; files?: string[]; unavailable?: string } | null | undefined): Evidence | null {
    if (!result) return null;
    if (result.unavailable) {
      this.counterfactual = 'unavailable';
      return this.addEvidence('note', `counterfactual not possible: ${result.unavailable}`);
    }
    if (typeof result.revertedExitCode !== 'number') return null;
    const red = result.revertedExitCode !== 0;
    this.counterfactual = red ? 'red' : 'green';
    return this.addEvidence(
      'counterfactual',
      red
        ? `with the fix reverted (${(result.files ?? []).join(', ') || 'changed files'}), \`${result.command ?? 'the repro'}\` fails again (exit ${result.revertedExitCode}) — the fix is what makes it pass.`
        : `with the fix reverted, \`${result.command ?? 'the repro'}\` STILL PASSES — this test does not exercise the change, so it proves nothing about the cause.`
    );
  }

  get counterfactualState(): CounterfactualState {
    return this.counterfactual;
  }

  get hasFailingRepro(): boolean {
    return this.failingCommands.size > 0;
  }

  // ── The hypothesis ledger (the `debug_ledger` tool) ──

  addHypothesis(text: string, predicts: string): { hypothesis?: Hypothesis; error?: string } {
    if (!text.trim()) return { error: 'text must say what you think is wrong.' };
    if (!predicts.trim()) return { error: 'predicts must say what you would OBSERVE if this is true — a hypothesis you cannot test is a guess.' };
    if (this.hypotheses.length >= MAX_HYPOTHESES) return { error: `At most ${MAX_HYPOTHESES} hypotheses per run — resolve the open ones or act on the confirmed one.` };
    const hypothesis: Hypothesis = { id: `H${this.hypotheses.length + 1}`, text: text.trim().slice(0, 300), predicts: predicts.trim().slice(0, 300), status: 'open', evidence: [] };
    this.hypotheses.push(hypothesis);
    return { hypothesis };
  }

  /**
   * Settle a hypothesis. The evidence ids must be ones this run RECORDED: that
   * is the whole evidence gate — a hypothesis cannot be confirmed or refuted by
   * assertion.
   */
  resolve(id: string, status: string, evidenceIds: readonly string[], note?: string): { hypothesis?: Hypothesis; error?: string } {
    const h = this.hypotheses.find((x) => x.id === id);
    if (!h) return { error: `No hypothesis ${id}. Known: ${this.hypotheses.map((x) => x.id).join(', ') || 'none — add one first'}.` };
    if (status !== 'confirmed' && status !== 'refuted') return { error: 'status must be "confirmed" or "refuted".' };
    const known = new Set(this.evidence.map((e) => e.id));
    const unknown = evidenceIds.filter((e) => !known.has(e));
    if (unknown.length) return { error: `Evidence ${unknown.join(', ')} was never recorded in this run. Recorded: ${[...known].join(', ') || 'none yet'}. Run the repro or a probe to get some.` };
    if (!evidenceIds.length) return { error: `Cite at least one recorded evidence id (${this.evidence.map((e) => e.id).join(', ') || 'none yet — run the repro or add a probe first'}).` };
    h.status = status;
    h.evidence = [...evidenceIds];
    if (note) h.note = note.trim().slice(0, 300);
    return { hypothesis: h };
  }

  /** What the edit gate needs: has the run observed anything, and thought of more than one cause? */
  editReadiness(): string | null {
    const missing: string[] = [];
    if (this.evidence.length === 0 && !this.hasFailingRepro) {
      missing.push('no observation yet — run the repro (a failing command or test) or add a probe, so the cause is seen rather than assumed. If the bug cannot be reproduced here, use ask_user for the missing data or environment');
    }
    if (this.hypotheses.length < 2) {
      missing.push(`${this.hypotheses.length} hypothesis recorded — record at least two competing causes with debug_ledger, each with what it predicts`);
    }
    return missing.length ? missing.join('; and ') : null;
  }

  // ── The claim check ──

  /** Why `answer`'s "confirmed" is not backed by this run's state; empty when it is, or when it does not claim confirmation. */
  claimIssues(answer: string): string[] {
    if (claimedRootCauseStatus(answer) !== 'confirmed') return [];
    const issues: string[] = [];
    const known = new Set(this.evidence.map((e) => e.id));
    const cited = (answer.match(EVIDENCE_ID_RE) ?? []).filter((id) => known.has(id));
    if (!cited.length) issues.push('the root cause cites no recorded evidence id (E1, E2, …)');
    if (!this.hypotheses.some((h) => h.status === 'confirmed')) issues.push('no hypothesis was confirmed against evidence with debug_ledger');
    if (this.writes > 0 && !this.reproPassId) issues.push('the failing repro was not shown passing after the fix');
    if (this.writes > 0 && this.counterfactual !== 'red') {
      issues.push(
        this.counterfactual === 'green'
          ? 'the repro still passes with the fix reverted, so it does not prove the cause'
          : this.counterfactual === 'unavailable'
            ? 'the fix could not be reverted to check it (counterfactual_check was unavailable)'
            : 'the fix was never reverted to show the repro fails without it (counterfactual_check)'
      );
    }
    if (this.writes === 0 && !this.evidence.some((e) => e.kind === 'repro-fail' || e.kind === 'probe')) {
      issues.push('nothing executed backs the cause — it rests on reading code');
    }
    return issues;
  }

  /** The harness's own record, appended to the final report so the reader sees what was actually established. */
  ledgerMarkdown(): string {
    if (!this.hypotheses.length && !this.evidence.length) return '';
    const lines: string[] = ['### Evidence ledger (recorded by the harness)'];
    if (this.hypotheses.length) {
      lines.push('', '| Hypothesis | Predicts | Result | Evidence |', '|---|---|---|---|');
      for (const h of this.hypotheses) {
        lines.push(`| ${h.id}: ${cell(h.text)} | ${cell(h.predicts)} | ${h.status}${h.note ? ` — ${cell(h.note)}` : ''} | ${h.evidence.join(', ') || '—'} |`);
      }
    }
    if (this.evidence.length) {
      lines.push('');
      for (const e of this.evidence) lines.push(`- **${e.id}** (${e.kind}) ${brief(e.text)}`);
    }
    lines.push('', `Proof: repro red before the fix ${this.reproFailId ? `(${this.reproFailId})` : '— not recorded'}; green after ${this.reproPassId ? `(${this.reproPassId})` : '— not recorded'}; red with the fix reverted ${this.counterfactual === 'red' ? '— yes' : this.counterfactual === 'green' ? '— NO (still passes)' : '— not checked'}.`);
    return lines.join('\n');
  }
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

/** The first two non-empty lines on one line: "`cmd` failed (exit 1): — Expected 6, received 3". */
function brief(s: string): string {
  const parts = s.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  return parts.join(' — ').slice(0, 220);
}
