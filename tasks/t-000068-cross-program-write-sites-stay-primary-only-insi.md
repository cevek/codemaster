---
id: t-000068
title: "Cross-program WRITE sites stay PRIMARY-only inside a `transaction"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: multi-program
created: '2026-07-08T00:01:07.000Z'
---
**Cross-program WRITE sites stay PRIMARY-only inside a `transaction`** — the rename /
change_signature site fan-out is gated OFF when a step runs under a `PlanningOverlay` (a
sibling reading stale disk would be unsound, ls-host TRAP), so a transaction step that
renames/change-sigs a symbol a `test/**` sibling references rewrites only the primary sites.
The fanned §2.8 gate then REFUSES the whole transaction on the resulting dangle (honest, never
a silent partial), but the step can't yet COMPLETE cross-program. Fix: make the planning
overlay sibling-aware (seed each sibling's overlay from the cumulative tree). `bug`·`low`·`cx:M`
