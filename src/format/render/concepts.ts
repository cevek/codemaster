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
  'dials: verbosity=terse (default; file:line:col) · normal (+first line) · full (verbatim text). format:"json" for machine composition. To project columns, post-filter with `sql` (SELECT the columns you want from the op table `t`).',
  "sql: a batch (or op) carrying `sql` loads each aliased (`as`) request's table into an ephemeral in-memory SQLite db and runs ONE read-only SELECT — anti-joins / negations / aggregates over op outputs. Producers run uncapped; a `partial` table makes NOT IN untrustworthy.",
  '  e.g. batch {requests:[{as:"r",name:"find_usages",args:{symbols:["Input"],role:"jsx",groupBy:"enclosing"}},{as:"f",name:"find_usages",args:{symbols:["useAppForm"],groupBy:"enclosing"}}], sql:"SELECT encloser FROM r WHERE encloser NOT IN (SELECT encloser FROM f)"}',
  'confidence: certain (type-proven) · partial (incomplete) · dynamic (computed dispatch) · unresolved — a partial/dynamic claim is honest uncertainty, not a fact.',
  'truncation: "… N more (shown X/Y; hint)" and "!! OUTPUT CAPPED" — never assume completeness past a marker. FAIL tool=… means codemaster could not, and you should fall back to your own tools.',
  'freshness: "reindexed N at entry" = your just-made edits were picked up · "PENDING N" = index behind, re-run · none / "current @commit" = fresh. bad args end with "— valid: {…}", a call you can copy.',
  'cross-repo: `root` is a TOP-LEVEL field, beside `name`/`args` (NOT inside `args`) — `op {name,args,root}` or a batch request `{name,args,root}`; resolution request root > tool root > cwd. One batch can mix repos and a mixed-root `sql` join runs across them. SymbolIds do not cross roots (re-search in the new root). The status header lists the warm roots.',
];
