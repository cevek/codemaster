// The `concepts` block of the `status` reply (spec-status-as-the-doc §2): the shared
// mechanics that belong to no single op — target forms, the output dials, sql
// post-filtering, and the honesty legend. `status` IS the per-repo documentation (§7,
// §11), so this is authored ONCE here and rendered into every status reply. It lives in
// the format layer (not ops/) because it is pure rendered text with no per-op data and
// format/ may not import ops/. Clauses, not paragraphs — the token budget is real.
//
// The sql clause names `find_usages` concretely (the canonical join case). Every repo
// codemaster targets has the `ts` plugin, so it is always in the catalogue; a hypothetical
// scss-only repo would show an op it lacks. Accepted: the worked example earns its keep,
// and `test/unit/concepts-example.test.ts` keeps the named op/column honest.

/** Fully-formatted concept lines, appended under a `concepts:` header by render-status. */
export const CONCEPTS_LINES: readonly string[] = [
  'targets: symbol-addressed ops take {symbolId:"ts:…"} (a SymbolId from a prior answer) · {name} (a bare name — must be unambiguous; ambiguity returns the candidate list) · {file,line,col} (1-based). symbolId is ONLY a SymbolId, never a bare name (that is name). A SymbolId chains across calls; if its file moved the answer states handle: rebound (proof+confidence) or gone — never a silent retarget.',
  'dials: verbosity=terse (default; file:line:col) · normal (+first line) · full (verbatim text). format:"json" for machine composition. To project columns, post-filter with `sql` (SELECT the columns you want from the op table `t`). Mutating ops also take summaryOnly:true — the verdict + ONE merged `touched` list (each file +added/-removed; a moved-away/deleted source marked `(removed)`) instead of the full diff.',
  "sql: a batch (or any op call) carrying `sql` loads each aliased (`as`) request's table into an ephemeral in-memory SQLite db and runs ONE read-only SELECT — anti-joins / negations / aggregates over op outputs. Producers run uncapped; a `partial` table makes NOT IN untrustworthy.",
  '  e.g. batch {requests:[{as:"r",name:"find_usages",args:{symbols:["Input"],role:"jsx",groupBy:"enclosing"}},{as:"f",name:"find_usages",args:{symbols:["useAppForm"],groupBy:"enclosing"}}], sql:"SELECT encloser FROM r WHERE encloser NOT IN (SELECT encloser FROM f)"}',
  'confidence: certain (type-proven) · partial (incomplete) · dynamic (computed dispatch) · unresolved — a partial/dynamic claim is honest uncertainty, not a fact.',
  'truncation: "… N more (shown X/Y; hint)" and "!! OUTPUT CAPPED" — never assume completeness past a marker. FAIL tool=… means codemaster could not, and you should fall back to your own tools.',
  'freshness: "reindexed N at entry" = your just-made edits were picked up · "PENDING N" = index behind, re-run · none / "current @commit" = fresh. bad args end with "— valid: {…}", a call you can copy.',
  "mutating-gate: every mutating op is dry-run by default (writes nothing — returns the unified diff, touched files & the post-edit typecheck). apply:true is refused only if the edit INTRODUCES new typecheck errors (vs a pre-edit baseline — a repo's pre-existing errors ride along as a preExisting count, never blocking) and rolls back byte-exact if the post-apply typecheck shows newly-introduced errors. Edit sites are rewritten across ALL loaded programs (a `test/**` ref under a sibling tsconfig too) and the gate runs on every affected program — including the one whose glob owns a move/extract DEST, so a block erroneous under a disjoint dest tsconfig (divergent `lib`/`strict`) is refused, not silently applied.",
  "cross-program-read: reference / importer / usage sites are FOUND & COUNTED across ALL the repo's loaded TS programs — a hit in a `test/**` file under a sibling tsconfig (tsconfig.test.json), a build script, or Vite's app/node split is included, not just main-program ones (deduped where programs overlap).",
  'cross-program-limits (mutating ops): (a) the capture-safety check (the type-compatible silent re-bind) runs on the PRIMARY program ONLY — the gate still catches a resulting dangle/type error, just not a type-COMPATIBLE re-bind a sibling would see. (b) inside a `transaction` the write-site fan-out is OFF: a step rewrites primary-program sites only, though the cumulative gate still fans across every program and refuses a cross-program dangle.',
  'cross-repo: `root` is a TOP-LEVEL field on any op-tool call (beside the op args, NOT inside `args`) — `<op> {…args, root}` — or on a batch request `{name,args,root}`; resolution request root > tool root > cwd. One batch can mix repos and a mixed-root `sql` join runs across them. SymbolIds do not cross roots (re-search in the new root). The status header lists the warm roots.',
];
