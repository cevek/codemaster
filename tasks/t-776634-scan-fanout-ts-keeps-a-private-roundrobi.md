---
id: t-776634
title: scan-fanout.ts keeps a private roundRobin generator identical to common/iter/round-robin.ts — two copies of the one-budget-across-a-fan primitive
status: backlog
priority: low
type: imp
complexity: S
area: multi-program
source: dogfood-jul
relates:
  - t-467009
surface:
  - plugins/ts/program/scan-fanout.ts
audience: internal
evidence: measured
created: '2026-07-30T15:26:22.069Z'
---
`plugins/ts/program/scan-fanout.ts` defines a private `roundRobin<T>` generator (the queue interleave
that spreads ONE budget across a fan). `trace_type_widening`'s reference fan needs the same primitive
but cannot import a private one, so it was lifted to `common/iter/round-robin.ts` — the
layering-correct home (pure logic over no domain type). The copy in `scan-fanout.ts` still stands.

Both are byte-equivalent today, so this is drift-in-waiting rather than a live defect: an edit to one
(a fairness change, a deadline poll inside the interleave) silently leaves the other fan on the old
policy, and the two fans would then spend their budgets differently while their notes claim the same
guarantee.

Fix: delete the private generator, import `roundRobin` from `common/iter/round-robin.ts`. No
behaviour change — assert by the existing `scan-fanout-honesty` / `scan-coverage-honesty` suites
staying green.
