---
id: t-885983
title: "The floor's SCOPE must be decided ONCE for both levels: narrowing it (t-000075) and hoisting it to the envelope (t-071368) land two contradictory confidences in one answer"
status: backlog
priority: high
parent: t-786727
type: imp
complexity: M
area: correctness
source: dogfood-jul
relates:
  - t-286255
  - t-290877
  - t-316487
  - t-828100
audience: internal
evidence: measured
created: '2026-07-30T11:17:56.178Z'
---
## The collision (found by reading the whole impact-usages/ts-core/multi-program slice, 126 bodies, in one pass)

- `t-000075` wants the undiscovered-program floor NARROWER — symbol-module-scoped, not repo-global.
- `t-071368` wants the same condition BROADER — emitted from the resolve chokepoint onto the envelope so
  every op inherits it.

Land both naively and one answer carries a repo-global, target-level `!! CANNOT CLAIM` beside a
symbol-scoped `complete:true` payload: two confidences about one read — exactly the drift the closed
`UnsafeClaim` union exists to prevent (§3.4). Neither body mentions the other. The scope has to be decided
ONCE, for both levels, before either ships.

## Second pair, same slice, same hot path

`t-233072` proposes re-querying navto with a LARGER budget when the exact bucket saturates; `t-662704`
proposes a `getDefinitionAtPosition` PER CANDIDATE before the view cap. Same 50/200 budget, the hottest
resolve path, and the costs multiply. Neither body mentions the other (§1: no per-call work that scales).

## Done means

A written scope decision (which level owns the claim, and at what granularity) recorded where both tasks
can be read against it — then both bodies rewritten to that decision. Not code.
