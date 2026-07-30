// The scope every no-program SYNTACTIC path answers within — stated once, read by every op that offers
// one (`search_symbol {syntactic:true}`, `source {syntactic:true}`).
//
// It lives beside `syntactic-surface.ts` because it is a claim about what THAT function scans. Prose
// kept in `ops/` would go false the moment the surface changed, with nothing linking the two — no
// import, no type, no test. `INTERNAL_UNAVAILABLE` (syntactic-internal.ts) is the same kind of
// agent-facing sentence about the same layer's fact, and sits in the plugin for the same reason.
//
// Stated POSITIVELY (§3.6 report-capability): what WAS scanned, then what was not. Never "may have
// missed". And never "a degraded version of the checker path": the surface is WIDER on two axes — a
// file no tsconfig includes is scanned here, and a nested / member / destructured declaration is
// addressable here while the checker path's name resolution only anchors top-level ones — so an agent
// reading "syntactic" as strictly worse would skip it exactly where it is the more complete of the two.
// What it cannot do is verify types.

/** What the scan covered, what it did not, and the axes on which it beats the checker path. */
export const SYNTACTIC_SCOPE =
  'scanned all git-tracked (plus untracked-not-ignored) source under the workspace root — complete there for declarations carrying a plain-identifier name, and WIDER than the type-verified path on two axes: a file no tsconfig includes is scanned, and a nested/member/destructured declaration is addressable. Not type-verified. A tsconfig include/reference reaching OUTSIDE the root is not covered — use the default path for those.';
