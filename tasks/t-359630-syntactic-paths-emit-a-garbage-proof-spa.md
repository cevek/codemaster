---
id: t-359630
title: syntactic paths emit a garbage proof span for a computed / string-literal declaration name
status: backlog
priority: medium
type: bug
complexity: S
area: ts-core
source: dogfood-jul
surface:
  - src/plugins/ts/syntactic-search.ts
audience: external
evidence: measured
created: '2026-07-30T12:38:00.725Z'
---
## The defect

`nameAnchor` returns the start of the declaration's name NODE, and `syntactic-search.ts` then builds the
proof span as `[anchor, anchor + name.length)`. For a name whose SOURCE is wider than its TEXT those two
disagree, so the span proves a range that is not the name:

- `'a-b'() {}` (string-literal member) → span text `'a-` (the map key is `a-b`, 3 chars, the source is 5)
- `[Symbol.iterator]() {}` → span text `[Symbol.`
- `declare module "ambient"` → span text `"ambien`

§16 invariant 1 still passes — the text DOES equal the source at the emitted range — so the harness cannot
see it. What is wrong is the range: it is not the name it claims to locate, and the `file:line:col` an
agent chains from it points mid-token.

## Scope

`search_symbol {syntactic:true}` and (via the same construction) `symbols_overview`'s name catalogue. NOT
`source {syntactic:true}`: `syntactic-decl-index.ts` reads the name node's own `getEnd()` (`DeclSite.nameEnd`),
so its spans are correct — that fix is the shape to lift.

## Fix

Take the end from the name node, as the declaration index does, instead of adding the text length. One
line at the span construction; the callers need no change.
