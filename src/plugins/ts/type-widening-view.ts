// The PUBLIC view types of `wideningSinksAt` — what `trace_type_widening` reads (§5-L2). They live
// in their own leaf so the fan driver (`type-widening.ts`) and the per-reference classifier
// (`type-widening-sink.ts`) can both name them without an import cycle.
//
// The coverage below is REFERENCE-denominated, and that is not a stylistic divergence from the
// file-denominated `program/scan-coverage-view.ts` the type-anchored SCANS carry: this scan
// enumerates candidates with `getReferencesAtPosition`, not by walking a program's files, so it has
// no file denominator at all. Reusing the file-shaped one would make its completeness discriminator
// (`walkedFiles === 0` → "nothing walked") fire on a value that simply has no forward reference —
// printing `!! NOT A VERDICT` over an answer the fan fully established, which §3.6 names as the same
// lie inverted. Same doctrine ("an empty SCAN and an empty RESULT are different facts"), different
// unit.

import type { RepoRelPath } from '../../core/brands.ts';
import type { Confidence, Span } from '../../core/span.ts';
import type { WideningKind } from './type-widening-verdict.ts';

export type WideningRelation = 'assigned-to' | 'passed-to' | 'returned-as' | 'reassigned-to';

export type WideningEndpoint = { span: Span; label: string; typeText: string };

export type WideningSink = {
  relation: WideningRelation;
  to: WideningEndpoint;
  widened: boolean;
  kind?: WideningKind;
  confidence: Confidence;
  note?: string;
  /** The label of the program that surfaced this reference AND judged it, present only when that is
   *  NOT the program the endpoint type was read from. Two programs are two checkers, so a sibling's
   *  verdict is sound but is stated under sibling options — the reader is told whose. */
  program?: string;
  /** How the SOURCE value's type reads in `program`, present only when it differs from the endpoint
   *  type this view reports (which is the authority's — see `type-widening.ts`). The verdict is
   *  computed from THIS type, so where two configs type one value differently the hop would
   *  otherwise print a `from` label that is not what the comparison used. */
  srcTypeText?: string;
  /** Where the forward walk continues (the param/variable the value rebinds to); absent at a leaf
   *  (`returned-as` / `reassigned-to`) or a precision-erasing boundary (`any`/`unknown` — STOP). */
  next?: { file: RepoRelPath; line: number; col: number };
};

/** What ONE fanned program contributed, as a matched PAIR: a bare `examined:` numerator with no
 *  denominator and no scope is what let a four-file package scan read as a repo scan (t-919920). */
export interface WideningProgramCoverage {
  label: string;
  /** Forward references this program surfaced and CLAIMED (the union dedups; the first program in
   *  fan order wins a reference two programs both see) — the denominator. */
  refs: number;
  /** Of those, how many the shared per-step budget actually checked. */
  examined: number;
}

/** A program the fan contained but did NOT consult, and why — a closed union because each reason
 *  has its OWN remedy (§3.6 / t-259465):
 *   · `no-value-here` — the position resolves to no value symbol under THAT program's own options,
 *     so it has no source type to judge sinks against. Neither a budget nor a missing config.
 *   · `deadline` — the wall-clock budget was spent before the fan reached it; its checker was never
 *     warmed and its references were never enumerated.
 *   · `program-unavailable` — the LS could not produce a Program (or the target's source file) for
 *     it: an internal-tool failure, not a scope decision. */
export interface SkippedWideningProgram {
  label: string;
  reason: 'no-value-here' | 'deadline' | 'program-unavailable';
}

/** The positive scope of ONE forward step's cross-program reference fan. Machine-readable so the op
 *  renders a verdict instead of prose: `0 sinks` is a claim about the value only when this says the
 *  fan consulted every program that contains it. */
export interface WideningScanCoverage {
  /** Per program CONSULTED, in fan order (the value's type authority first). */
  programs: WideningProgramCoverage[];
  /** Union of forward references claimed across the fan — what the step set out to check. */
  refs: number;
  examined: number;
  /** The per-step budget that bounded the checks — carried, never re-derived at the op. */
  limit: number;
  /** Programs the fan held but did not consult. Absent when the whole fan was consulted. */
  skipped?: SkippedWideningProgram[];
  /** No real-config program contains the value: the step ran on the whole-repo no-config fallback,
   *  whose DEFAULT options resolve no `paths` and absorb whole-repo strays. */
  fallbackOnly?: true;
  /** A no-config fallback program containing the value was DEMOTED out of the fan (a real config
   *  took over), so references living only in files no tsconfig covers were never enumerated. */
  fallbackExcluded?: true;
  /** The cooperative deadline expired mid-step (§19) — the sinks found are real, the step is not
   *  finished. */
  deadlineHit?: true;
}

export type WideningSinksView = {
  node: WideningEndpoint;
  sinks: WideningSink[];
  /** The per-step budget cut the reference set. `totalIsLowerBound` when the denominator is itself a
   *  floor (a program in the fan was never consulted, so its references were never counted). */
  truncated?: { shown: number; total: number; totalIsLowerBound?: true };
  coverage: WideningScanCoverage;
};

/** Fold one step's coverage into the walk's running total (the op traverses many steps and states
 *  ONE scope). Per-program counters SUM across steps — each step is a fresh reference query, so the
 *  totals are "references this program surfaced over the whole trace", which is the denominator the
 *  scope line prints. Skips union by label+reason; every floor flag is sticky (an OR), because a
 *  single unconsulted program makes the whole trace a floor. */
export function mergeWideningCoverage(
  into: WideningScanCoverage | undefined,
  next: WideningScanCoverage,
): WideningScanCoverage {
  if (into === undefined) return next;
  const programs = [...into.programs.map((p) => ({ ...p }))];
  for (const p of next.programs) {
    const existing = programs.find((q) => q.label === p.label);
    if (existing === undefined) programs.push({ ...p });
    else {
      existing.refs += p.refs;
      existing.examined += p.examined;
    }
  }
  const skipped = [...(into.skipped ?? [])];
  for (const s of next.skipped ?? []) {
    if (!skipped.some((q) => q.label === s.label && q.reason === s.reason)) skipped.push(s);
  }
  return {
    programs,
    refs: into.refs + next.refs,
    examined: into.examined + next.examined,
    limit: into.limit,
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(into.fallbackOnly === true || next.fallbackOnly === true ? { fallbackOnly: true } : {}),
    ...(into.fallbackExcluded === true || next.fallbackExcluded === true
      ? { fallbackExcluded: true }
      : {}),
    ...(into.deadlineHit === true || next.deadlineHit === true ? { deadlineHit: true } : {}),
  };
}
