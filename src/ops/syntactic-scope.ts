// The scope every no-program SYNTACTIC path answers within (t-515730 / t-229522) — stated once, read
// by every op that offers one (`search_symbol {syntactic:true}`, `source {syntactic:true}`).
//
// One claim, one home. The scope is a property of the SURFACE (the §10 git source listing under the
// workspace root), not of any one op, so each op restating it in its own prose is how two answers about
// the same surface come to describe it differently — and an agent that meets a signal twice, worded
// twice, learns to skim it (t-034392).
//
// Stated POSITIVELY (§3.6 report-capability): what WAS scanned, then the one thing that was not. Never
// "may have missed". And never "a degraded version of the checker path": the surface is WIDER in one
// respect — a file no tsconfig includes is scanned here and is invisible to the checker path — so an
// agent reading "syntactic" as strictly worse would skip it exactly where it is the more complete of
// the two. What it cannot do is verify types.

/** What the scan covered, what it did not, and the one axis on which it beats the checker path. */
export const SYNTACTIC_SCOPE =
  'scanned all git-tracked (plus untracked-not-ignored) source under the workspace root — complete for declarations there, and WIDER than the type-verified path in one respect: a file no tsconfig includes is scanned here. Not type-verified. A tsconfig include/reference reaching OUTSIDE the root is not covered — use the default path for those.';
