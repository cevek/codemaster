// The honesty vocabulary of `find_unused_exports`' WALK — what was enumerated, out of what, in which
// program, and (when the walk opened nothing) which of the two causes emptied it.
//
// It is this op's own module rather than a reuse of `ops/scan-coverage.ts` because that module's
// structure is a FAN's: `scan-coverage.ts` says so itself — "a synthesized one-program coverage would
// make `scanScopeFields` print `programsScanned` — a claim about a fan that never ran". This walk
// enumerates one program's files (`host.service.getProgram()`), so `walkedFiles`/`skipped`/`limit`/
// `fallbackOnly` would all have to be invented to fit that shape. What IS shared is the wording a
// reader must recognise across answers: `NOT_A_VERDICT_MARKER` and its doctrine, imported below.
//
// Its neighbour for the fan case is `scanCoverage`'s `emptyScanRemedy`, and the two say DIFFERENT
// things about different mechanisms: that one reports the union of a fan's files and names the
// programs scanned, this one reports one program's own file set and names that program — and the
// filter this one names scopes the DECLARATION file, while usage discovery still spans everything.
// Folding those into a single sentence would produce one that is wrong for both. What the two DO say
// identically is the doctrine (`EMPTY_SCAN_DOCTRINE`), which is therefore shared, not re-typed.
//
// Every counter here is a matched PAIR, and the pre-filter denominator (`eligibleFiles`) is also the
// DISCRIMINATOR: a filter that emptied a populated program and a program that holds no source are two
// causes with two different levers, and telling them apart must not require reading prose (§3.4/§3.6).

import { NO_CONFIG_LABEL } from '../plugins/ts/program/discover.ts';
import { EMPTY_SCAN_DOCTRINE, NOT_A_VERDICT_MARKER } from './scan-coverage.ts';

/** The walk's shape — the fields of the ts plugin's view this module reads, and only those. */
export interface UnusedExportsWalk {
  /** Files WALKED — after `pathInclude`/`pathExclude`. */
  scannedFiles: number;
  /** Files the program holds BEFORE the path filter — the denominator, and the discriminator. */
  eligibleFiles: number;
  /** Candidate exports EXAMINED (one reference search each). */
  scannedExports: number;
  /** Candidate exports ENUMERATED — the denominator. */
  candidateExports: number;
  /** The program whose files were enumerated. */
  walkedProgram: string;
}

/** The empty-WALK marker (§3.4), shown as the first data field + an sql note whenever the scan opened
 *  no file at all: `unused (0)` is then "nothing was examined", not "no export is dead".
 *
 *  ONE key for both causes, because they are mutually exclusive by construction and a consumer that
 *  had to probe two keys to learn whether a verdict exists is the defect that key closes. The CAUSE —
 *  and with it the one lever that can change the outcome (§3.6) — is chosen off the FILE SET, never
 *  off whether a filter arg was passed: a program covering no source empties the walk whether or not
 *  a `pathInclude` rides along, and blaming the glob there names a lever no value of which could have
 *  helped (the t-259465 inert lever, inside the message written to prevent it). The arg-presence test
 *  is wrong in both directions — a `pathInclude: []` is a filter that is never applied (the scope
 *  predicate ignores an empty list), so it too must not be blamed. */
export function notAVerdictWarning(walk: UnusedExportsWalk): string {
  const head = `${NOT_A_VERDICT_MARKER} —`;
  const doctrine = `so no export was examined: ${EMPTY_SCAN_DOCTRINE} — NOT proof that no exports are dead.`;
  if (walk.eligibleFiles > 0) {
    // The program HOLDS source; the filter rejected all of it. Stated as what the filter LEFT, never
    // as what it MATCHED: a `pathExclude` that empties the walk matched EVERY file, and telling its
    // author "your glob matched nothing" steers them to widen the exclude — the one edit that keeps
    // the walk empty forever. "Left 0 in scope" is true of both filters.
    return `${head} the path filter (pathInclude/pathExclude) left 0 of the ${walk.eligibleFiles} source file(s) \`${walk.walkedProgram}\` holds in scope, ${doctrine} Globs are REPO-relative and are matched against the DECLARATION file's path; drop the filter to scan all ${walk.eligibleFiles}.`;
  }
  // The program itself covers no source file. No glob can be widened into files that are not there,
  // so the filter is not named at all — whether or not one was passed. WHICH program it is decides the
  // remedy: a repo with no tsconfig cannot be told to fix its `include`, and naming the fallback
  // program in one clause while prescribing a config edit in the next is that inert lever, self-
  // contradicting inside one sentence.
  if (walk.walkedProgram === NO_CONFIG_LABEL) {
    return `${head} this repo has no tsconfig, so the walk ran on the whole-repo fallback program — and it globbed no non-declaration source file at all, ${doctrine} There is no \`include\` to widen and no filter that could have matched: add a tsconfig covering the sources, or point \`root:\` at the package that has one.`;
  }
  return `${head} the program \`${walk.walkedProgram}\` covers 0 source files, ${doctrine} No path filter could have matched here, so setting or widening one cannot help — check that the project's tsconfig \`include\`/\`files\` actually covers its sources (a target under another package? pass \`root:\`).`;
}

/** The positive scope of the walk, stated in the line itself (§3.4): both counter pairs with their
 *  denominators, plus the NAME of the program they are counted over — a bare `files=4` is read as
 *  "scanned the repo", which has already cost one agent a false theory about the mechanism.
 *
 *  The second line states enumeration as a FACT and usage as a RULE, with no count attached. The
 *  usage fan is per-candidate (`classifyExport`: the primary, then only for a candidate dead there,
 *  the loaded programs containing its declaration file), so any "searched across N programs" number
 *  would claim searches that never ran — and the discovery label set is what a program set "will
 *  load", not what was consulted. It also names the limit that follows from enumeration being
 *  single-program: an export declared only in another program is not a candidate at all. */
export function unusedExportsScope(walk: UnusedExportsWalk): string[] {
  return [
    // NOT "in-scope": `eligibleFiles` is the set BEFORE the path filter, while "in scope" names the
    // post-filter set everywhere else in this op (the `inScope` predicate, `scannedFiles`' own doc).
    // Calling the denominator in-scope would ask the reader why files that ARE in scope went unwalked.
    `${walk.walkedProgram}: walked ${walk.scannedFiles} of the ${walk.eligibleFiles} source file(s) it holds; examined ${walk.scannedExports} of ${walk.candidateExports} export(s)`,
    'enumeration is single-program — an export declared only in ANOTHER program is never a candidate here; usage for each candidate dead here is re-searched in every loaded program containing its declaration file (a `test/**`-only use IS seen).',
  ];
}
