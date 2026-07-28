---
id: t-048595
title: NEGATIVE RESULT — an op cannot see the op catalogue as data (`ctx.daemon.opNames` is names only), so "audit the ops themselves" has no in-engine producer; recorded with the reasoning for NOT building one
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-137057
  - t-820448
surface:
  - daemon
  - ops
audience: internal
evidence: measured
created: '2026-07-28T08:45:16.973Z'
---
Filed as a NEGATIVE result so the next reader does not redo the assessment.

The whole class "audit the ops themselves" — which ops lack a guard, which declare a plugin they never
use, which carry a table projection — has no in-engine producer. `ctx.daemon.opNames` exposes names only;
the enriched catalogue (deps, flags, table shape, notes) lives in the engine and is not reachable as rows
from inside an op.

**Why it was NOT built during t-933867**, and why that was right: the audit turned out to be answerable
WITHOUT it. `find_usages` on `defineOp` yields the call sites, and their set was verified equal to
`builtinOps()` (37 = 37) — a precise registry, not a heuristic. So the missing producer would have been a
second path to a fact already obtainable, at the cost of a new engine surface. Enriching the catalogue
also means touching `daemon/**`, i.e. a cross-layer change for an internal-audit convenience.

When it WOULD become worth it: the moment an audit needs a field that is not derivable from source shape —
e.g. "which ops declare `requires:['ts']` but never touch the ts plugin" needs the declared deps as data,
and `defineOp` call sites alone will not give that without parsing each call's argument object.

Until then the `defineOp`-call-sites route is the documented answer (see the recipe in `concepts`), and
this task exists so the alternative is not re-evaluated from scratch each time someone notices the gap.
