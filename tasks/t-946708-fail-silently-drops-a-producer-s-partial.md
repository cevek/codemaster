---
id: t-946708
title: "`fail()` silently drops a producer's `partial: true` — three process-host sites intend a partial and ship `partial: false`, with no type or lint signal"
status: backlog
priority: medium
tags:
  - dogfood
  - platform
type: bug
complexity: S
area: correctness
source: dogfood-jul
relates:
  - t-163532
surface:
  - common
  - daemon
audience: internal
evidence: repro
created: '2026-07-28T17:15:14.848Z'
---
`common/result/construct.ts` `fail()` builds `{ ...failure, partial: false }` — the spread is
overwritten, so a `partial: true` handed to `fail()` is discarded in silence. `partial()` is the
constructor that honors it, and it requires `data`, which is exactly the discrimination intended.

Three call sites in `daemon/process-host.ts` pass `partial: true` into `fail()` and therefore ship
`partial: false`:

- `request()`'s unexpected-reply arm (`{ tool: 'engine-process', message, partial: true }`)
- `produceSql()`'s `bad` failure (same shape)
- `failAll()` carried one until t-615758 removed it as inert

Nothing detects this: `ToolFailure.partial` is optional, the argument type-checks, and the
overwrite is invisible at the call site. So the author's intent ("this is a partial") and the
envelope's claim ("this is not") disagree, and the envelope wins.

Two questions, and they are not the same:

1. **Is the claim currently WRONG?** These arms carry no `data`, so `partial: false` is arguably
   the honest value and the call sites are merely dead intent. If so, delete the flags — silently
   ignored arguments are how the next author concludes the field works.
2. **Should `fail()` be able to swallow it at all?** A constructor that accepts a field and
   discards it is a small lie about its own contract. `Omit<ToolFailure, 'partial'>` for `fail()`'s
   parameter (as `partial()` already does) turns every such site into a compile error and forces
   the caller to pick `fail` or `partial` deliberately.

Found while building t-615758; out of that track's scope because (2) changes a shared constructor's
signature across the tree.
