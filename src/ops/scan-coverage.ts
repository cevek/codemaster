// The ops-level honesty vocabulary for the type-anchored SCANNING reads — `construction_sites` and
// `discrimination_sites` (t-162650). Both walk a program's files and run one expensive checker call
// per candidate, so both can answer `0` for five materially different reasons. This is their single
// home for saying WHICH, because five causes with five distinct remedies collapsed into one note is
// exactly the §3.4 shape that made a `0` unreadable: an agent cannot act on "widen pathInclude" when
// the real cause is a program that was never scanned.
//
// Everything below the marker is `ScanCoverage`-shaped and so is those two ops' alone. The one
// exception is `NOT_A_VERDICT_MARKER`, which is shared with any op reaching an empty walk by its own
// route (`find_unused_exports`, whose walk is primary-program-only): the WORDING is common because a
// reader must recognise it across answers; the STRUCTURE is not, because a synthesized one-program
// coverage would make `scanScopeFields` print `programsScanned` — a claim about a fan that never ran.
//
// One fact per note, each naming a lever that CAN change the outcome (§3.6 / t-259465):
//   · nothing walked        → the answer is NOT a verdict at all (an empty SCAN, not an empty RESULT)
//   · a program SKIPPED     → the fan narrowed itself; its remedy is neither budget nor config
//   · budget exhausted      → the program IS loaded; `limit` / `pathInclude` are the working levers
//   · undiscovered config   → the config was never loaded; loading it is the lever (`lowerBoundNote`)
//   · fallback-only files   → no real tsconfig covers them; adding one is the lever
//   · deadline expired      → the scan is unfinished; nothing about the levers above applies
//
// Every shortfall is denominated in FILES, never in candidates: `candidates` is counted only inside
// files the walk already opened, so after a deadline cut `examined of candidates` reads as an EXHAUSTED
// sweep (`0 of 0`) while whole files went unread. A denominator that already excludes what it is
// reporting cannot state a shortfall.
//
// The budget cause deliberately does NOT ride `lowerBoundNote`'s undiscovered-config wording: that
// note's remedy is "index the config", which is inert when the config is loaded and the shortfall is
// a spent budget. Two authorities on one question is what the closed disclosure vocabulary exists to
// prevent.

import type { ScanCoverage } from '../plugins/ts/program/scan-coverage-view.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { lowerBoundNote } from './lower-bound-note.ts';

const MAX_NAMED = 3;

/** The marker an op prints when its walk opened NOTHING — the one wording for "an empty SCAN is not
 *  an empty RESULT", shared with the ops outside this module that reach the same state by their own
 *  route (`find_unused_exports`, whose walk is primary-program-only and so carries no `ScanCoverage`).
 *  A phrase copied per call site is a phrase that drifts on the first edit, and the two readings must
 *  never diverge: an agent that learns this marker in one answer must recognise it in the next. */
export const NOT_A_VERDICT_MARKER = '!! NOT A VERDICT';

/** The doctrine the marker stands for, in one clause — the fact that an unexamined scope and an
 *  examined-and-empty one are different findings. Shared for the same reason the marker is: it is the
 *  SAME utterance wherever it appears (the surrounding cause and remedy are not, and are written
 *  per-op), and a reader who learns it in one answer must meet the identical words in the next. */
export const EMPTY_SCAN_DOCTRINE = 'this is an EMPTY SCAN, not an empty RESULT';

/** The three states a scan's emptiness can be in. Only `complete` licenses a semantic verdict
 *  ("no literal is assignable to T"); `nothing-walked` licenses NO claim about T whatsoever.
 *
 *  The discriminator is DID WE FINISH, not `examined === 0`. A repo where every claimed file was
 *  walked and simply holds no candidate of this kind has `examined === 0` and yet is COMPLETE —
 *  absence really was established there, and printing `!! NOT A VERDICT` over it would dress a
 *  complete answer as partial, which §3.6 names as the same lie inverted. */
export type ScanCompleteness = 'nothing-walked' | 'incomplete' | 'complete';

export function scanCompleteness(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
): ScanCompleteness {
  if (coverage.walkedFiles === 0) return 'nothing-walked';
  if (
    coverage.walkedFiles < coverage.files ||
    coverage.candidates > coverage.examined ||
    coverage.skipped !== undefined ||
    undiscovered.length > 0 ||
    coverage.fallbackOnlyFiles !== undefined ||
    coverage.fallbackOnly === true ||
    coverage.deadlineHit === true
  ) {
    return 'incomplete';
  }
  return 'complete';
}

/** The machine-readable positive scope (§3.4): WHICH programs were walked and how much of each, so
 *  a count-only consumer reads the scope without parsing prose — and so `files=4` can never again be
 *  mistaken for "scanned the repo" (the mis-diagnosis this field exists to prevent). `complete` is
 *  present only when the scan fell short; a complete scan stays byte-identical to an unadorned one
 *  apart from `programsScanned`. */
export interface ScanScopeFields {
  /** Present ONLY when the scan fell short — a complete scan adds no `complete` key at all, so its
   *  answer stays byte-identical apart from the positive scope. */
  complete?: false;
  programsScanned: string[];
  /** The fan's UNSCANNED programs, each with its reason. Without this the scope of a fan the deadline
   *  emptied would be an empty list — silence exactly where the answer is thinnest. */
  programsSkipped?: string[];
  undiscoveredPrograms?: string[];
}

export function scanScopeFields(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
): ScanScopeFields {
  const complete = scanCompleteness(coverage, undiscovered) === 'complete';
  return {
    ...(complete ? {} : { complete: false }),
    programsScanned: coverage.programs.map(
      (p) =>
        `${p.label}: ${p.walked}${p.walked === p.files ? '' : ` of ${p.files}`} file(s) walked, ` +
        `${p.examined}/${p.candidates} candidate(s) checked`,
    ),
    ...(coverage.skipped !== undefined
      ? { programsSkipped: coverage.skipped.map((e) => `${e.label} (NOT scanned: ${e.reason})`) }
      : {}),
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
  };
}

/** The scope line for the sql/table surface. That surface forwards `data.notes` verbatim, so every
 *  floor cause already reaches it — what it lacked was the DENOMINATOR: bare `examined/candidates`
 *  with nothing saying what was walked is the defect this module exists to close, and it must not
 *  survive on a second surface. Deliberately says nothing about the budget: a cap sentence here would
 *  state the same fact `data.notes` already carries, in a second wording (§3.4 one authority). */
export function scanTableNotes(data: unknown): string[] {
  const scope = (data as { programsScanned?: unknown }).programsScanned;
  if (!Array.isArray(scope) || scope.length === 0) return [];
  return [`programs scanned: ${scope.map((s) => String(s)).join(' · ')}`];
}

/** What the answer is a floor OF, in the op's own words — so one shared assembler can write five
 *  causes without inventing the domain nouns. `subject`/`noun`/`negation` feed `lowerBoundNote`. */
export interface ScanSubject {
  /** Plural counted thing: 'construction sites' / 'discriminating switch/if-chains'. */
  subject: string;
  /** Singular: 'construction site' / 'discriminating switch'. */
  noun: string;
  /** The false conclusion a low count invites, for `lowerBoundNote`. */
  negation: string;
  /** The cheap syntactic thing counted as a candidate: 'object literal' / 'switch/if-head'. */
  candidate: string;
}

/** Every floor/soundness note the coverage warrants, verdict-first (§12). Empty for a complete
 *  scan, so the common answer gains no prose. */
export function scanFloorNotes(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
  subject: ScanSubject,
): string[] {
  const notes: string[] = [];
  if (coverage.deadlineHit === true) {
    // The denominator is FILES, never `candidates`: candidates are counted only inside walked files,
    // so `examined of candidates` after a cut can read `500 of 500` — a finished scan — while whole
    // files went unopened. A shortfall must be stated in a unit that can express it.
    notes.push(
      `!! PARTIAL SCAN — the wall-clock budget expired after walking ${coverage.walkedFiles} of ${coverage.files} in-scope file(s) (${coverage.examined} ${subject.candidate}(s) checked in them); the ${coverage.files - coverage.walkedFiles} remaining file(s) were NOT opened, so their ${subject.subject} are absent from this answer. The ${subject.subject} listed ARE real. Narrow with pathInclude to finish within the budget.`,
    );
  }
  if (coverage.candidates > coverage.examined) notes.push(budgetNote(coverage, subject));
  if (undiscovered.length > 0) {
    notes.push(
      lowerBoundNote(undiscovered, {
        subject: subject.subject,
        noun: subject.noun,
        negation: subject.negation,
      }),
    );
  }
  for (const note of skippedNotes(coverage, subject)) notes.push(note);
  const unscanned = coverage.fallbackOnlyFiles;
  if (unscanned !== undefined) {
    notes.push(
      `!! LOWER BOUND — ${unscanned} file(s) are covered by NO tsconfig (only by the whole-repo no-config fallback program), so they were NOT scanned: under its DEFAULT options (no \`paths\`/\`baseUrl\`, whole-repo glob) a type verdict is not the one the project itself yields, and a wrong verdict is worse than a named gap. Add a tsconfig covering those files for a complete answer.`,
    );
  }
  if (coverage.fallbackOnly === true) {
    notes.push(
      `!! the repo has no tsconfig covering the target, so the scan ran on the whole-repo no-config fallback program under DEFAULT compilerOptions — alias imports do not resolve there and whole-repo type augmentations leak in, so each verdict is weaker than it looks. Add a tsconfig for a sound answer.`,
    );
  }
  return notes;
}

/** One note per SKIP REASON — grouped, because three programs skipped for one reason share one
 *  remedy and repeating it per program would spend the reserved note budget restating a single fact.
 *  Deliberately NOT folded into the budget or config vocabulary: a program whose T is not checkable
 *  under its own options is not a spent budget and not a missing config, and offering either remedy
 *  would be an inert lever (§3.6 / t-259465). */
function skippedNotes(coverage: ScanCoverage, subject: ScanSubject): string[] {
  const skipped = coverage.skipped;
  if (skipped === undefined || skipped.length === 0) return [];
  const byReason = new Map<string, string[]>();
  for (const s of skipped) {
    const labels = byReason.get(s.reason) ?? [];
    labels.push(s.label);
    byReason.set(s.reason, labels);
  }
  const out: string[] = [];
  for (const [reason, labels] of byReason) {
    const named = nameWithMore(labels, MAX_NAMED);
    out.push(
      `!! LOWER BOUND — ${labels.length} program(s) in the fan were NOT scanned (${named}): ${SKIP_CAUSE[reason] ?? reason}. Any ${subject.noun} living only in their files is absent from this answer.`,
    );
  }
  return out;
}

/** Exhaustive over `SkippedProgram['reason']` — cause AND remedy in one clause each, so a new reason
 *  cannot fall through to a plausible-but-wrong sentence (it renders its raw tag instead, loudly). */
const SKIP_CAUSE: Record<string, string> = {
  'no-checkable-type': `the target does not resolve to a checkable type under that program's OWN compilerOptions (vacuous / not a union there), so its files could not be judged against it — neither a spent budget nor a missing config; re-run with that package as \`root\` to query the target under those options`,
  deadline: `the wall-clock budget was already spent when the fan reached them, so their checkers were never warmed — narrow with pathInclude so the budget reaches the whole fan`,
  'program-unavailable': `the TS Language Service could not produce a Program for them (an internal-tool failure, not a scope decision)`,
};

/** The budget cause, with its OWN remedy. Names the programs whose candidates were left unchecked so
 *  "loaded but unfinished" can never be read as "never loaded" — the levers are `limit` (raise) and
 *  `pathInclude` (narrow), both of which work here, unlike indexing a config. */
function budgetNote(coverage: ScanCoverage, subject: ScanSubject): string {
  const short = coverage.programs
    .filter((p) => p.candidates > p.examined)
    .map((p) => `${p.label} (${p.examined}/${p.candidates})`);
  const where = short.length > 0 ? ` — unchecked in: ${nameWithMore(short, MAX_NAMED)}` : '';
  // The denominator is itself a floor when files went unopened or programs unscanned: `candidates`
  // only ever counts what the walk reached. Printing it bare would state a floor as exact (§12).
  const floor =
    coverage.walkedFiles < coverage.files || coverage.skipped !== undefined ? '\u2265' : '';
  return `!! LOWER BOUND — budget: ${coverage.examined} of ${floor}${coverage.candidates} ${subject.candidate}(s) checked (limit ${coverage.limit})${where}. These programs ARE loaded; the shortfall is the budget, NOT a missing config — raise \`limit\` or narrow \`pathInclude\` to finish. A low ${subject.noun} count here is NOT proof ${subject.negation}.`;
}

/** The emptiness line for a 0-site answer — the §3.4 core of this module. An empty SCAN and an empty
 *  RESULT are different facts, so `nothing-walked` yields an explicit NOT-A-VERDICT line and never the
 *  op's semantic prose; `incomplete` states the shortfall (the causes are already spelled out by
 *  `scanFloorNotes`, so this only refuses the verdict); `complete` is the ONLY state that may print
 *  the op's own "none exist" verdict — and it prints it even at 0 candidates, because a finished walk
 *  over a repo that holds none of them HAS established absence. `undefined` when sites were found. */
export function scanEmptinessNote(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
  siteCount: number,
  subject: ScanSubject,
  completeVerdict: string,
): string | undefined {
  if (siteCount > 0) return undefined;
  switch (scanCompleteness(coverage, undiscovered)) {
    case 'nothing-walked':
      return `${NOT_A_VERDICT_MARKER} — 0 file(s) were walked, so no ${subject.candidate} was checked and nothing about ${subject.subject} was established: ${EMPTY_SCAN_DOCTRINE}. ${emptyScanRemedy(coverage)}`;
    case 'incomplete':
      return `no ${subject.noun} among the ${coverage.examined} ${subject.candidate}(s) checked in the ${coverage.walkedFiles} file(s) walked — the scan is INCOMPLETE (see the floor note(s) below), so this is NOT proof ${subject.negation}.`;
    case 'complete':
      return completeVerdict;
  }
}

/** Why the walk opened no file at all, and the ONE lever that can change it. Reached only from
 *  `nothing-walked`, so the two branches below are exhaustive over how that state arises: either the
 *  fan's programs hold no scannable file, or the path filter rejected every one they hold. Never names
 *  `pathInclude` in the first case — a filter cannot be widened into files that do not exist (the
 *  t-259465 inert-lever defect, which is exactly what the old single-program note did). */
function emptyScanRemedy(coverage: ScanCoverage): string {
  const scanned = coverage.programs.map((p) => p.label);
  const named = scanned.length > 0 ? nameWithMore(scanned, MAX_NAMED) : 'none';
  if (coverage.deadlineHit === true) {
    // The budget was spent before anything ran. Whether the fan's programs were even reached decides
    // which sentence is true — the files are not known to be absent in either case, so neither "no
    // scannable file exists" nor "your glob is wrong" may be printed here.
    const reached =
      coverage.files > 0
        ? `BEFORE the first of ${coverage.files} in-scope file(s) was opened`
        : `BEFORE any program in the fan could be consulted, so nothing is known about the target here`;
    return `The wall-clock budget expired ${reached} — nothing ran. Narrow with pathInclude, or retry against a warm engine.`;
  }
  if (coverage.files === 0 && coverage.eligibleFiles > 0) {
    return `Your pathInclude/pathExclude matched 0 of the ${coverage.eligibleFiles} file(s) the program(s) scanned (${named}) hold — the path filter, not the program set, emptied the scan. Globs are REPO-relative; drop the filter to scan all ${coverage.eligibleFiles}.`;
  }
  return `The program(s) scanned (${named}) contain NO scannable source file, so no scope filter could have helped. Target a symbol whose own tsconfig covers source files.`;
}
