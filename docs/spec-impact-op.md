# Task D — `impact`: type-aware blast radius (read-only)

> Self-contained task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §17 (it's on the
> roadmap as "`impact` — type-aware blast radius") + §1 (NEVER HANG — this op is the prime
> unbounded-traversal risk), call `status`, READ `find_usages` (`src/ops/find-usages.ts` + the `ts`
> plugin usages module) — `impact` is a bounded transitive closure over it.

## Why

Before a refactor an agent needs "if I change X, what transitively depends on it?" — a risk estimate
grep can't give. Very agent-native.

## Scope — IN

- New read op **`impact { symbol?|name?|file+line+col, depth?: 1-N (default small), kind?, ... }`**:
  the transitive set of dependents of the target, computed as a **bounded** BFS over `find_usages`
  (encloser rollup → those enclosers' usages → …). Proof-carrying (each hop carries file:line +
  `confidence`/`provenance`); a dynamic-dispatch hop is FLAGGED `dynamic`, never silently bridged.
- **HARD bound (§1 — never hang):** cap depth AND total nodes; report the cap explicitly
  (`!! reached depth/node cap`) — a truncated closure must NEVER read as complete. No per-call work
  that scales unbounded with repo size.
- Output: dependents grouped by file/encloser, ranked by proximity (depth) or fan-in; chainable
  SymbolIds. Consider a `summary` shape (counts per depth) so the agent can gauge risk without a wall
  of refs.

## Scope — OUT

- Mutation (it's read-only). · `affected` (changed-files→tests; separate roadmap op). · scale.

## Definition of done

- `fix-and-check` GREEN; full suite 0 fail.
- Oracle-backed test: a hand-curated fixture with a known transitive dependent set (incl. a
  dynamic-dispatch hop that must surface as `dynamic`/`partial`, and a depth-cap case that reports
  truncation). NOT golden-only. A cycle must terminate (visited-set) — assert no hang.
- Ethos: bounded+terminating (visited-set + depth/node cap), wrapped, honest truncation+confidence.
  Layering (ops→plugins); files ≤300. Self-describe in `status`. Dogfood live through the MCP on a
  real repo (pick a j2-3-deep symbol and eyeball the closure).

## Files

`src/ops/impact.ts` (new) · the `ts` plugin (a transitive-closure helper over usages, or compose at
op level) · `src/ops/builtins.ts` (register — **OVERLAP** with B/C/F) · `src/format/` · status
catalogue · tests.

## Parallel-run note

Independent (read-only, additive). Shares `builtins.ts` + status golden with B/C/F (mechanical
merges — distinct op entries). Own branch/worktree off `main`.
