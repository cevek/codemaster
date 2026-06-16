# Task H — find_usages role & encloser-rollup fidelity (+ the impact accuracy it gates)

> Self-contained, FAT task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §3, call
> `status`, READ `src/plugins/ts/usage-roles.ts` (`classifyRole` + `findEncloser`),
> `src/plugins/ts/usages.ts` (rollup), `src/ops/impact.ts` + `impact-closure.ts`.

## Why

`find_usages` is the foundation `impact` (and any closure tool) builds on. Two role/rollup
mis-classifications surfaced while building `impact`, and they propagate into wrong/limited impact
output:

1. **Interface/type member signatures are tagged `read`** (feedback bug 11:44). A `MethodSignature`/
   `PropertySignature` occurrence inside an `interface`/type literal is a TYPE-level declaration, not
   a value read — `classifyRole` has no case for it and falls through to read/write. This produces a
   spurious "value read" that `impact` reads as a possible dynamic-dispatch escape → a noisy false
   `dynamic` boundary on an ordinary symbol with an interface signature.
2. **A reference in a top-level non-function value binding rolls up to the MODULE node, not the
   binding** (feedback bug 11:45). `export const b = a();` / `export const cfg = { f: dep }` rolls to
   the synthetic `(top-level file.ts)` encloser because `findEncloser` only treats a `const` as a
   named encloser when its initializer is an arrow/function. The module-rollup SymbolId
   `(top-level file.ts)@file:1:1` can't be re-resolved → any transitive tool DEAD-ENDS at the module
   (impact reports this honestly as an un-expandable leaf + `complete:false`, but the root cause is
   here).

Fixing both makes `find_usages` more accurate AND lets `impact` close the dead-ends it currently has
to flag.

## Scope — IN

1. `classifyRole`: occurrences inside an interface/type-literal member signature → `decl` (or a
   `type` role) — NOT `read`/`write`. (Keep the honest read/write split for real value bindings.)
2. `findEncloser`: treat ANY top-level named `VariableDeclaration` as an encloser (kind
   `variable`/`const`), not just function-valued ones — so `b`/`cfg` roll up to themselves with a
   re-resolvable SymbolId.
3. `impact` follow-through (now that the rollup yields re-resolvable binding ids):
   - **module-rollup leaves** become expandable — a value-binding dependent's own dependents are
     reachable (plan.md §5 impact residual "module-rollup leaves").
   - **precise escape-site span** — a `dynamic` boundary is currently flagged at the _encloser's_
     span; point it at the actual value-read site (plan.md impact residual).
4. Re-validate the §2-impact callable-const dynamic-boundary fix still holds (the `callable` flag).

## Scope — OUT

- Multi-program/test-tsconfig visibility (Task G). · `impact` "type-error blast radius" (simulate the
  change — a larger, separate enhancement; leave noted). · `batch+sql` TableSpec for impact.

## Definition of done

- `fix-and-check` green; full suite 0 fail. Oracle-backed: a fixture pinning (a) an interface method
  signature → role `decl`/`type` not `read`; (b) `export const b = a()` rolls up to encloser `b`
  (re-resolvable id), not the module; (c) `impact` expands through `b` to `b`'s own dependents
  (closure no longer dead-ends), and the dynamic-escape span points at the read site. Hand-curated,
  not golden-only.
- Honesty preserved (roles still proof-carrying; impact caps/`dynamic` flags intact). Layering;
  files ≤300. Dogfood live. Watch the existing find_usages/impact differential tests for regressions
  (this changes role/encloser output — update goldens only for intended shifts).

## Files (likely)

`src/plugins/ts/usage-roles.ts` · `src/plugins/ts/usages.ts` · `src/ops/impact.ts` +
`impact-closure.ts` · tests under `test/differential/`.

## Parallel-run note

Overlaps Task G in the usages query area (real merge if concurrent). Own worktree off `main`.
Covers: feedback bugs 11:44 + 11:45; plan.md impact residuals "module-rollup leaves" + "precise
escape-site span".
