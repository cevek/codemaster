// The `@internal` TS pattern matcher — the ONE fuzzy-name matcher shared by the two no-program
// syntactic paths (t-515730 / t-960572): the fuzzy `search_symbol { syntactic: true }` scan and the
// `symbols_overview { query }` catalogue filter. Kept in one module so the two consumers can never drift
// on the match semantics (the copy-paste risk the extraction removes) and so both reuse navto's OWN
// matcher (identical recall by construction, §4).
//
// `createPatternMatcher` is TS `@internal` (absent from the public typescript.d.ts) but is a pure,
// project-agnostic function navto itself is built on. This is NOT a second parser / structural index
// ahead of the LS (the §4 concern): it is only a note about @internal-API stability. Typed via a
// single `as unknown as` boundary block (never `any`); a `typeof`-guard so a TS bump that DROPS the
// helper yields `undefined` (the caller fails honestly), never a crash.

import ts from 'typescript';

/** A navto match — `kind` is the rank order: exact=0 < prefix=1 < substring=2 < camelCase=3. */
export interface PatternMatch {
  readonly kind: number;
}
export interface PatternMatcher {
  getMatchForLastSegmentOfPattern(candidate: string): PatternMatch | undefined;
}

/** Build navto's project-agnostic matcher for `pattern`. Returns `undefined` when the `@internal`
 *  helper is absent (a TS bump) OR the pattern is degenerate — the caller fails honestly, never
 *  crashes, never guesses (§3.6 / never-crash). */
export function createPatternMatcher(pattern: string): PatternMatcher | undefined {
  const factory = (
    ts as unknown as { createPatternMatcher?: (p: string) => PatternMatcher | undefined }
  ).createPatternMatcher;
  if (typeof factory !== 'function') return undefined;
  return factory(pattern);
}
