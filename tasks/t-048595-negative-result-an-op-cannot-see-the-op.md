---
id: t-048595
title: NEGATIVE RESULT — an op cannot see the op catalogue as data (`ctx.daemon.opNames` is names only), so "audit the ops themselves" has no in-engine producer; recorded with the reasoning for NOT building one
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: platform
source: dogfood-inbox-aug
relates:
  - t-137057
  - t-820448
surface:
  - daemon
  - ops
audience: both
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

## The premise of this negative result does not hold for an EXTERNAL caller (2026-08-08)

The reasoning above rests on one step: the audit was answerable without the producer, via `find_usages` on `defineOp` call sites verified against `builtinOps()`. That route requires being INSIDE this repository — it reads codemaster's own source. Every conclusion drawn from it is therefore scoped to an internal auditor, and the task was filed `audience: internal` accordingly.

The recurring question turns out to be external, and for that caller the route does not exist:

> "Does this op have a scope lever?" — the question every capped repo-wide answer raises.

An agent working in someone else's repository cannot grep our `src`, cannot run `find_usages` over `defineOp`, and cannot fetch the full catalogue (`status {full:true}` is terse-by-default precisely because the complete one overruns the output ceiling). `status {op:'<name>'}` answers for ONE op, so a comparison across five ops is five round-trips and five separate readings, with nothing to diff them against.

So the tool's own argument surface is the single surface it cannot be asked about relationally — while every other corpus it touches is queryable.

### This is not hypothetical: it decided a triage outcome

Establishing whether `find_unused_scss_classes` has a path filter "the way find_usages does" required knowing, for five ops at once, whether each accepts one and IN WHAT SHAPE. Answered by `grep -n "pathInclude" src/ops/*.ts`. Result: present and FLAT on `find_unused_{scss_classes,exports,i18n_keys}` (since 2026-06-16), ABSENT on `find_unused_props`, and nested under `filter:{}` on `find_usages`.

That spread is the whole finding — an agent carrying the `find_usages` model looks for `filter:{pathInclude}`, does not find it, and concludes no filter exists (t-549028). A cross-op schema question is thus not meta-curiosity: it is how a caller discovers that the capability it wants lives under a different spelling.

### What would satisfy it

The catalogue exposed as a TABLE so `sql` can be pointed at it — rows of `{op, argName, type, required, nested_under}`. Then "which ops accept pathInclude and how" is one SELECT, and the scope-lever question is answerable without fetching 36 schemas.

The condition this task itself set for revisiting — "the moment an audit needs a field not derivable from source shape" — is met from a direction it did not consider: not a harder field, but a caller with no access to the source at all. Priority raised low → high and audience internal → both on that basis. The original reasoning is left standing above, because it remains correct for the internal case it was written about.
