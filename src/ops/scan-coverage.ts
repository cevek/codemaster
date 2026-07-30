// The ops-level honesty vocabulary for the type-anchored SCANNING reads — `construction_sites` and
// `discrimination_sites` (t-162650). Both walk a program's files and run one expensive checker call
// per candidate, so both can answer `0` for five materially different reasons. This is their single
// home for saying WHICH, because five causes with five distinct remedies collapsed into one note is
// exactly the §3.4 shape that made a `0` unreadable: an agent cannot act on "widen pathInclude" when
// the real cause is a program that was never scanned.
//
// One fact per note, each naming a lever that CAN change the outcome (§3.6 / t-259465):
//   · nothing examined      → the answer is NOT a verdict at all (an empty SCAN, not an empty RESULT)
//   · budget exhausted      → the program IS loaded; `limit` / `pathInclude` are the working levers
//   · undiscovered config   → the config was never loaded; loading it is the lever (`lowerBoundNote`)
//   · fallback-only files   → no real tsconfig covers them; adding one is the lever
//   · deadline expired      → the scan is unfinished; nothing about the levers above applies
//
// The budget cause deliberately does NOT ride `lowerBoundNote`'s undiscovered-config wording: that
// note's remedy is "index the config", which is inert when the config is loaded and the shortfall is
// a spent budget. Two authorities on one question is what the closed disclosure vocabulary exists to
// prevent.

import type { JsonValue } from '../core/json.ts';
import type { ScanCoverage } from '../plugins/ts/program/scan-fanout.ts';
import { nameWithMore } from '../common/truncate/name-with-more.ts';
import { lowerBoundNote } from './lower-bound-note.ts';

const MAX_NAMED = 3;

/** The three states a scan's emptiness can be in. Only `complete` licenses a semantic verdict
 *  ("no literal is assignable to T"); `nothing-examined` licenses NO claim about T whatsoever. */
export type ScanCompleteness = 'nothing-examined' | 'incomplete' | 'complete';

export function scanCompleteness(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
): ScanCompleteness {
  if (coverage.examined === 0) return 'nothing-examined';
  if (
    coverage.candidates > coverage.examined ||
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
export function scanScopeFields(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
): Record<string, JsonValue> {
  const complete = scanCompleteness(coverage, undiscovered) === 'complete';
  return {
    ...(complete ? {} : { complete: false }),
    programsScanned: coverage.programs.map(
      (p) => `${p.label}: ${p.files} file(s), ${p.examined}/${p.candidates} candidate(s) checked`,
    ),
    ...(undiscovered.length > 0 ? { undiscoveredPrograms: [...undiscovered] } : {}),
  };
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
  limit: number,
): string[] {
  const notes: string[] = [];
  if (coverage.deadlineHit === true) {
    notes.push(
      `!! PARTIAL SCAN — the wall-clock budget expired after ${coverage.files === 0 ? 0 : coverage.examined} of ${coverage.candidates} ${subject.candidate}(s); the ${subject.subject} found are real, the scan is UNFINISHED. Narrow with pathInclude to finish within the budget.`,
    );
  }
  if (coverage.candidates > coverage.examined) notes.push(budgetNote(coverage, subject, limit));
  if (undiscovered.length > 0) {
    notes.push(
      lowerBoundNote(undiscovered, {
        subject: subject.subject,
        noun: subject.noun,
        negation: subject.negation,
      }),
    );
  }
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

/** The budget cause, with its OWN remedy. Names the programs whose candidates were left unchecked so
 *  "loaded but unfinished" can never be read as "never loaded" — the levers are `limit` (raise) and
 *  `pathInclude` (narrow), both of which work here, unlike indexing a config. */
function budgetNote(coverage: ScanCoverage, subject: ScanSubject, limit: number): string {
  const short = coverage.programs
    .filter((p) => p.candidates > p.examined)
    .map((p) => `${p.label} (${p.examined}/${p.candidates})`);
  const where = short.length > 0 ? ` — unchecked in: ${nameWithMore(short, MAX_NAMED)}` : '';
  return `!! LOWER BOUND — budget: ${coverage.examined} of ${coverage.candidates} ${subject.candidate}(s) checked (limit ${limit})${where}. These programs ARE loaded; the shortfall is the budget, NOT a missing config — raise \`limit\` or narrow \`pathInclude\` to finish. A low ${subject.noun} count here is NOT proof ${subject.negation}.`;
}

/** The emptiness line for a 0-site answer — the §3.4 core of this module. An empty SCAN and an empty
 *  RESULT are different facts, so `nothing-examined` yields an explicit NOT-A-VERDICT line and never
 *  the op's semantic prose; `incomplete` states the shortfall (the causes are already spelled out by
 *  `scanFloorNotes`, so this only refuses the verdict); `complete` is the ONLY state that may print
 *  the op's own "none exist in scope" verdict. `undefined` when sites were found. */
export function scanEmptinessNote(
  coverage: ScanCoverage,
  undiscovered: readonly string[],
  siteCount: number,
  subject: ScanSubject,
  completeVerdict: string,
): string | undefined {
  if (siteCount > 0) return undefined;
  switch (scanCompleteness(coverage, undiscovered)) {
    case 'nothing-examined':
      return `!! NOT A VERDICT — 0 ${subject.candidate}(s) were checked, so nothing about ${subject.subject} was established: this is an EMPTY SCAN, not an empty RESULT. ${emptyScanRemedy(coverage)}`;
    case 'incomplete':
      return `no ${subject.noun} among the ${coverage.examined} ${subject.candidate}(s) checked — the scan is INCOMPLETE (see the floor note(s) above), so this is NOT proof ${subject.negation}.`;
    case 'complete':
      return completeVerdict;
  }
}

/** Why the scan examined nothing, and the ONE lever that can change it. Exhaustive over the shapes
 *  that reach zero, so the remedy is never a guess — and never `pathInclude` when no path filter was
 *  passed, or when widening it cannot add a file (the accusation the single-program answer used to
 *  make at the caller). */
function emptyScanRemedy(coverage: ScanCoverage): string {
  const scanned = coverage.programs.map((p) => p.label);
  const named = scanned.length > 0 ? nameWithMore(scanned, MAX_NAMED) : 'none';
  if (coverage.eligibleFiles === 0) {
    return `The program(s) scanned (${named}) contain NO scannable source file, so no scope filter could have helped. Target a symbol whose own tsconfig covers source files.`;
  }
  if (coverage.files === 0) {
    return `Your pathInclude/pathExclude matched 0 of the ${coverage.eligibleFiles} file(s) the program(s) scanned (${named}) hold — the path filter, not the program set, emptied the scan. Globs are REPO-relative; drop the filter to scan all ${coverage.eligibleFiles}.`;
  }
  return `${coverage.files} file(s) were walked across ${named} but held 0 candidate(s) to check.`;
}
