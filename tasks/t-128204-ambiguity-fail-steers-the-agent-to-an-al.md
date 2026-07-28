---
id: t-128204
title: 'Ambiguity FAIL steers the agent to an ALIAS: all listed candidate sites are `(alias)` and the real declaration is absent or last, so "pass file:line:col" picks a re-export'
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-27T23:00:17.386Z'
---
A bare `{name}` that resolves to several declarations returns a candidate list the agent's NEXT call is
built on. Three defects made that list steer the agent onto an ALIAS, the worst of them a §3.4 lie:

## The mechanics (measured, not inferred)

`resolveByName` asked `searchSymbols(name, limit: 10)` and filtered the RESULT by exact name. navto's
matcher is fuzzy and its budget is spent BEFORE that filter and before the definition-dedup, so on a
barrel-heavy name the ten retained views were all re-export / import specifiers and the real declaration
never entered the list.

Repro (12 barrels `export { default as SaveButton } from './implN'` + one real `export function
SaveButton` in a later-discovered file) printed:

```
'SaveButton' is ambiguous (10 distinct declarations: src/a/bar1.ts:1:21 (alias), … ) — pass file:line:col
```

— ten candidates, every one an alias, the real declaration ABSENT, and the count itself FALSE (13
candidates existed) with no truncation marker. A count that looks complete while it isn't is §3.4's
"truncation that looks like completeness"; ranking is the lesser, second defect.

## The contract now

- The exact-name filter runs INSIDE the search (`ResolveNarrowing.nameExact`), so the budget buys only
  declarations of the asked-for name and `total` is their honest count. This also un-buries an exact name
  behind a case-insensitive fuzzy flood (a type `Span` behind 15 `span` consts).
- The view budget prefers real declarations over alias specifiers (`ResolveNarrowing.preferDeclarations`), so
  a barrel chain longer than the budget can no longer crowd the declaration out.
- Candidates collapse by resolved definition and rank declaration-first; within one definition a real
  declaration displaces the alias that points at it (`plugins/ts/ambiguity.ts`).
- The message states `shown X of [≥]Y` always, marks the display cap (`!! N more not shown`) and marks a
  budget-truncated total as a LOWER BOUND — the two truncations are separate because their remedies are.
- Each candidate prints as its canonical SymbolId (contains file:line:col — closes t-811470's ask) and an
  alias discloses the declaration it resolves to.

Oracles: `test/differential/ambiguity-candidates.test.ts` — 20 barrels (exact total asserted against the
fixture's construction) and 60 barrels (budget-truncated → floor asserted), each cross-checked against the
rank-independent `name+file` resolution of the real declaration.

Residual, filed separately: t-000524 — an import specifier whose module spec doesn't resolve under the
answering program reports ITSELF as its definition, so such aliases cannot collapse into the one
declaration they name (loose-root monorepo). The list stays honest and declaration-first; it is just
longer than it needs to be.

## A SECOND, DIFFERENT defect found on the same mechanic: §6 `gone` for a live symbol

The post-filter-a-fuzzy-page mechanic had a third call site — `resolveSymbolId`'s §6 REBIND
(`plugins/ts/resolve-target.ts`), which re-located a held handle with
`searchSymbols(name, 20).matches.filter(c => c.name === name)`. navto is case-insensitive, so a flood of
same-name-different-case symbols (25 × `export const span` beside the type `Span`) fills the 20 retained
views and the filter comes back EMPTY — the handle then answers
`{status:'gone', reason:'no symbol of this name/kind remains in the workspace'}` about a declaration that
is sitting in the file, merely moved a line.

This is NOT the ambiguity defect seen twice. Ambiguity is a false fact about a candidate SET; this is a
misreport of the IDENTITY of a held handle, and it breaks §6's own contract — "`gone` is never `merely
moved within this root`; that is always a `rebound`". It landed in this task only because the two share a
mechanic. Fixed on the same `ResolveNarrowing` path (exact name inside the search, declarations before
aliases so a rebind lands on the declaration rather than a barrel that re-exports it), with its own
oracle in `test/differential/ambiguity-candidates.test.ts`: a handle taken under a 25-symbol fuzzy flood,
its declaration then moved down a line, must rebind to the position the rank-independent `name+file` path
resolves — the pre-fix code answers `gone` there.

## Public-contract note (§3.6): the two knobs do NOT belong on `SearchFilter`

`SearchFilter` is re-exported from `src/index.ts` (the programmatic surface) and is the parameter type of
BOTH `searchSymbol` and `searchSymbolSyntactic` (`plugins/ts/api.ts`) — and the syntactic implementation
reads neither `nameExact` nor `preferDeclarations`. A type that advertises a field one of its two
implementors silently ignores is the §3.6 lie in the type system: a caller gets fuzzy, unranked results
with no disclosure. The two knobs therefore live in a separate `ResolveNarrowing` parameter of
`searchSymbols`, passed only from the resolve paths; `SearchFilter` stays the browse filter.
`nameExact` is required there, so ranking can never be requested without the narrowing that bounds how
much the ranking retains.

## A THIRD defect on the same mechanic: the LS's own page slice (found in review)

`searchSymbols` asks navto for a bounded page per program. TS sorts by matchKind + name with NO
case-sensitivity tie-break and SLICES to that budget — before codemaster's exact-name filter runs.
So a flood of `span` sits in the same `exact` bucket as `Span` and can push real declarations off
the page, and the obvious truncation test (`total > shown`) is blind to it: with the exact-name
group cut to exactly the view budget, `total === shown` and the answer printed as complete.

Measured consequences, all closed here: a complete-looking ambiguity count that was short of the
real number; `no symbol named 'X'` for a symbol that exists; a §6 `gone` on the same mechanism; and
— on the SUCCESS path — a silent uniqueness claim, with `mergeDeclarations` unioning a subset while
promising "ALL same-named declarations".

The page slice is now surfaced (`SearchView.searchTruncated`, detected by asking for one more item
than is used, so an exactly-full page is not mistaken for a cut one) and consumed three ways:
READS disclose (`searchCapFloor` → `complete:false` + `searchTruncated:true` + a `!!` note in
`find_definition` / `find_usages`; `search_symbol` marks its `total` a lower bound), the §6 rebind
refuses to claim `gone`, and WRITES refuse outright (`resolveForWrite`) — a mutation may not ride an
ambiguity gate that never actually ran (§7). `resolveAllByName` additionally carries codemaster's
own view-budget cut, which is the one that bites a merge.

Residual filed: t-876408 — the sibling read ops (`expand_type`, `impact`, `member_usages`, `source`,
…) still drop the flag, so they answer without the verdict their two siblings carry.
