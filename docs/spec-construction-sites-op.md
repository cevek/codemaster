# Task K — `construction_sites` op: type-aware "what builds a T?"

> Self-contained, FAT task (a net-new read op). Build on `main`. First: read `CLAUDE.md`,
> `ARCHITECTURE.md` §1 (never hang) + §3, call `status`, READ `src/ops/expand-type.ts` +
> `src/plugins/ts/type-expand.ts` (live-checker access) and an existing find-style op
> (`find-usages.ts`) for the op/table/proof-carrying shape.

## Why (the §7 deferred wish — grep can't do this)

"I added a required field to type `T` — which object-literal construction sites now break / build a
`T`?" There's no semantic answer today. `construction_sites {type: T}` returns every object literal
the CHECKER considers assignable to `T` — factory returns, array elements, variable initializers,
fixtures, call arguments — proof-carrying. The type-aware complement to `find_usages`.

## Scope — IN

- New read op **`construction_sites { symbol?|name?|file+line+col (the TYPE), pathInclude?,
pathExclude?, limit? }`**: find object-literal expressions (and relevant initializers) the live
  checker deems assignable to the target type, each with a proof span + the enclosing declaration.
- Use the project's own checker (assignability), not a syntactic heuristic. Honest confidence: a
  site reached only through a generic/`any`/inference boundary is `partial`/`dynamic`, never asserted
  `certain` when assignability isn't actually proven.
- **Bounded (§1 — never hang):** this is a whole-program type query; cap the scan (candidate object
  literals examined) and the result, report truncation explicitly (`!! …`), never a silent
  undercount. No unbounded per-call work — scope with pathInclude.
- Chainable SymbolIds on the enclosing declarations; a `table` projection for `sql`.

## Scope — OUT

- Mutation (read-only). · non-object construction (just object literals + initializers to start). ·
  the `css_cascade` wish (Task L).

## Definition of done

- `fix-and-check` green; full suite 0 fail. Oracle-backed (a cold `ts.Program` + hand-curated
  fixture, §16): for a type `T`, the op finds the assignable literals (factory return, array element,
  var init) and does NOT report a structurally-similar-but-not-assignable literal; a generic/`any`
  boundary is `partial`; the candidate cap reports honest truncation. NOT golden-only.
- Honesty: proof-carrying spans, confidence first-class, bounded+terminating, wrapped checker calls.
  Layering (op composes the `ts` plugin's checker access — add a plugin method if needed, don't poke
  internals). Files ≤300. Self-describe in `status` (summary + columns + notes + e.g.). Dogfood live.

## Files (likely)

`src/ops/construction-sites.ts` (new) · a `ts` plugin assignability/search method (new) ·
`src/ops/builtins.ts` (register) · `src/format/` · status catalogue · tests.

## Parallel-run note

Independent, additive (read-only). Shares only `builtins.ts`/status golden with other new-op tasks
(mechanical). Own worktree off `main`. Covers: spec-stresstest-findings §7 `construction_sites`.
