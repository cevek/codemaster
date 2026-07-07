---
id: t-000145
title: find_definition` full fallback can collapse a body-bearing sibling post-FLIP
status: backlog
priority: low
type: bug
complexity: S
area: full-density
created: '2026-07-08T00:02:24.000Z'
---
**`find_definition` full fallback can collapse a body-bearing sibling post-FLIP** — at full,
`render-result.ts:65-71` routes to `renderSource` only when `usable` (every definition has a non-empty
`decl` body); if ANY site lacks a `decl` object, the WHOLE result falls to `renderDense(condenseSpans)`,
where post-FLIP a body-bearing sibling's `decl` now collapses to `loc · firstline` instead of the full
body — violating `find_definition`'s own "full = whole body" note. Effectively DEAD today: both bug
reviewers could not make `declarationNodeOf` (`plugins/ts/declaration.ts`) return undefined for a real
definition site (overloads/merges/default-exports/re-export chains/lib types all resolve a decl). Guard:
a discriminating test (a find_definition with ≥2 sites, ≥1 no-decl + ≥1 body, at full) so a future
`declarationNodeOf` change or a new no-decl definition kind can't silently reintroduce the body-drop.
`bug`·`low`·`cx:S`
