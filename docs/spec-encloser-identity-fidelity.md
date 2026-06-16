# Task — Encloser identity & rollup fidelity (every rollup handle chainable, correctly-kinded, proof-carrying)

> Self-contained, FAT task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §3 (trust
> contract) + §6 (SymbolId re-resolution), call `status`, then READ
> `src/plugins/ts/usages.ts` (the rollup + `mintSymbolId` call site), `src/plugins/ts/usage-roles.ts`
> (`findEncloser`, the `Class.method` display-name construction), `src/plugins/ts/group-row.ts`
> (`GroupRow` shape + `omitGroupSite`), `src/plugins/ts/construction-encloser.ts` (Task K — already
> does the idName-vs-display split this task generalises), and `src/ops/find-usages.ts` + `impact.ts`.

## Why

`find_usages groupBy:'enclosing'` and `impact` roll references up to an **encloser** and hand back a
**SymbolId** for it. That id is the whole point of the rollup: an agent chains it
(`find_usages → find_definition / source / rename`). Task H made top-level value bindings chainable,
but three encloser classes still mint a handle that is wrong — a dead handle, a mis-kinded handle, or
a handle whose proof points at the encloser NAME instead of where the reference actually is. Each is a
quiet trust failure: the rollup _looks_ answered, but the next hop fails or misleads.

These all live in ONE seam — how `usages.ts` mints the encloser id and what `group-row.ts` exposes —
and Task K's `construction-encloser.ts` already solved the core sub-problem (mint the id on the BARE
token, keep the qualified string as a display field). This task generalises that into a shared helper
and closes the remaining encloser-fidelity gaps so EVERY rollup handle is chainable, correctly-kinded,
and proof-carrying at the reference level.

## The bugs

1. **Class-member encloser mints a NON-CHAINABLE SymbolId (the dead handle) — primary, a real bug.**
   In `groupBy:'enclosing'`, a class-method/property encloser's id is minted on the QUALIFIED display
   name `Class.method` (`usage-roles.ts` `${clsName}${member.name.text}`) but ANCHORED at the bare
   `method` token's line:col. So the §6 same-symbol check (`text.startsWith('Class.method', offset)`)
   is false at the `method` token, and the rebind filter (`searchSymbols(...).filter(c => c.name ===
'Class.method')`) is empty because navto reports the bare member name → the id resolves
   `{status:'gone'}`. Every class-member rollup is a dead handle: `find_usages groupBy:'enclosing'`
   over refs inside `class C { m(){ useX() } }`, then feeding the `m` encloser id to
   `find_definition`/`source`/`rename` → `gone`. Honest (not a silent wrong-bind), but breaks chaining.
   **Fix:** mint the id on the BARE member token; keep `Class.method` as a display / `container` field
   only — exactly what `construction-encloser.ts` already does. Unify the two mint sites
   (`usages.ts` rollup + `construction-encloser.ts`) behind ONE helper (idName/anchor vs display).

2. **A HOC/tagged-template-wrapped top-level component is kinded `const`, not `function`.**
   A binding like `const Foo = memo(() => …)`, `forwardRef(…)`, or a `styled.div` tagged template has
   a call / tagged-template initializer, so `findEncloser`'s `isFn` is false and a ref inside the
   callback rolls up to `Foo` with kind `const`. Chainable (Task H fixed that) and harmless to
   impact's value-flow, but a `find_usages`/`impact` `kind:'function'` VIEW filter SKIPS these
   renderable bindings — an under-report against a filter the agent reasonably trusts. **Fix:** peek
   through a known-HOC wrapper (or any call / tagged-template whose argument is an
   arrow/function-expression) and label the binding `function`.

3. **A `namespace`/`module`-nested top-level binding is not treated as an encloser → impact dead-ends.**
   `findEncloser`'s `topLevelVariableStatement` requires the `VariableStatement`'s parent to be the
   `SourceFile`, so a `const` declared inside `namespace N { … }` rolls up to the module node and its
   refs dead-end in impact just like the pre-Task-H top-level case. **Fix:** walk to the nearest
   `SourceFile`/`ModuleBlock` boundary so the binding is its own (re-resolvable) encloser.

4. **The representative reference SITE is recorded but stripped — grouped output is not proof-carrying
   at the reference level.** The rollup already records `GroupRow.site` (the span of the first
   reference inside each encloser) to power impact's value-flow boundary, but `group-row.ts` strips it
   before the agent sees it. A group today points at the encloser's NAME token ("Widget uses X ×3"),
   not at WHERE X is referenced. **Fix:** surface the representative `site` span in grouped
   `find_usages` output (and the SQL TableSpec) so a group is proof-carrying at the reference level.
   This widens the public output shape (new column, golden churn) — do it deliberately, with goldens,
   behind the existing terse/`verbosity` discipline (§12 verdict-before-bulk).

## Scope — IN

1. A shared encloser-id helper (idName/anchor token vs qualified display/`container`) used by BOTH
   `usages.ts` rollup minting AND `construction-encloser.ts` — one mint site, no drift. Bug 1.
2. HOC / tagged-template wrapper peek in `findEncloser` → kind `function` for callback-valued bindings.
   Bug 2.
3. `namespace`/`ModuleBlock`-nested binding treated as an encloser (walk to nearest module/file
   boundary). Bug 3.
4. Surface the representative reference `site` span in grouped `find_usages` (terse + verbose + SQL
   TableSpec), with goldens. Bug 4.
5. Re-validate `impact` closure: class-member / namespace-nested / HOC enclosers now expand through
   (no spurious dead-end), and the dynamic-escape span still points at the read site (Task H).

## Scope — OUT

- Member-level `find_usages` (tracing reads of a specific object-type FIELD, e.g. `GroupRow.site`) —
  a separate checker-backed capability (its own feedback wish); leave noted.
- Multi-program/test-tsconfig visibility (Task G). · The i18n all-partial UX collapse (separate theme).
  · The scss `parseFailures` absolute-path leak (separate, mechanical; parked in plan.md).

## Definition of done

- `fix-and-check` green; full suite 0 fail. Oracle-backed, hand-curated (not golden-only): a fixture
  pinning (a) a class-member encloser id from `groupBy:'enclosing'` RE-RESOLVES via
  `find_definition`/`source` (not `gone`) and `rename` finds it — the dead-handle is closed; (b) a
  `memo`/`forwardRef`/`styled` top-level binding is kinded `function` and survives a
  `kind:'function'` filter; (c) a `namespace N { const x = … }` binding rolls up to `x` (re-resolvable)
  and `impact` expands through it; (d) grouped `find_usages` emits a reference `site` span that equals
  the live source (§16 inv.1), distinct from the encloser name token.
- Honesty preserved: ids still proof-carrying; a genuinely-unresolvable encloser still reports `gone`
  honestly (no fabricated chainable id). Display/`container` field never confused with the id.
- Layering (imports flow downward; the shared helper lives in `plugins/ts/`); files ≤300 lines.
  Dogfood live through the MCP. Update the find_usages/impact/status goldens ONLY for intended shifts
  (the new `site` column is an intended output-shape change — own its goldens).

## Files (likely)

`src/plugins/ts/usages.ts` · `src/plugins/ts/usage-roles.ts` · `src/plugins/ts/group-row.ts` ·
`src/plugins/ts/construction-encloser.ts` (extract the shared helper) · `src/ops/find-usages.ts` ·
`src/ops/impact.ts` · new helper module under `src/plugins/ts/` · tests under `test/differential/` +
`test/unit/`; goldens under `test/golden/`.

## Parallel-run note

Overlaps Task G in the usages query area and shares the encloser/rollup seam with the just-landed
Task H — build in its own worktree off `main`. Covers: feedback bug "groupBy:'enclosing' mints a
non-chainable SymbolId for class-member enclosers" (24:43) + plan.md parked findings K-a (class-member
id), "HOC-wrapped component labelled const", "namespace-nested binding not an encloser", and the H
follow-up "expose the representative reference SITE in grouped find_usages".
