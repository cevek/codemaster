---
id: t-000156
title: '**intake: scalar→array coercion is TOP-LEVEL only'
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:35.000Z'
---
**intake: scalar→array coercion is TOP-LEVEL only — a pure-array field nested inside `filter{}`
is not coerced** — the auto-coercion (`arrayFieldsOf` over `op.argsSchema`) reads only top-level
schema fields, so `find_usages {filter:{pathInclude:"src"}}` (a scalar under the nested `filter`
object) still rejects; the top-level `pathInclude`/`pathExclude` of the 9 list-shaped ops, and
`find_usages.symbols`, ARE coerced. Recurse into nested object fields if the nested-scalar form
shows up in the fail log. `dx`·`low`·`cx:S`
