---
id: t-354613
title: Two task PAIRS collide if landed separately, and the contradiction is written in NEITHER body — planning hazard invisible to anyone reading one task at a time
status: backlog
priority: high
tags:
  - dogfood
  - platform
type: imp
complexity: S
area: correctness
source: dogfood-jul
relates:
  - t-000075
  - t-071368
  - t-233072
  - t-662704
audience: internal
evidence: reported
created: '2026-07-28T21:23:26.238Z'
---
Surfaced by reading 126 bodies in sequence. Both pairs are linked by `relates`, but the CONFLICT itself
appears in none of the four bodies — so a planner taking either task alone will not see it, and two
correct-looking changes will fight after merge.

**Pair 1 — scope of the same floor, two different levels.**
`t-000075` wants the floor NOW and SYMBOL-SCOPED. `t-071368` wants the same condition WIDER — on the
envelope, for every op. Landing both naively produces a repo-global claim at target level sitting next to
a symbol-scoped `complete:true` in the payload: exactly the drift the closed `UnsafeClaim` vocabulary
exists to prevent (§3.4/§3.6). Whoever takes either must decide the scope FIRST, once.

**Pair 2 — one budget, two claimants, on the hot path.**
`t-233072` proposes re-querying navto with a larger budget. `t-662704` proposes
`getDefinitionAtPosition` for EVERY candidate before the cap. Same budget, same hot path — the costs
multiply rather than add, and §1 (never-hang, no per-call work that scales) is cited in neither body.

## Why this is filed as a task rather than as notes on the four

Adding "beware of X" to each body would be four half-statements of one fact, and the first person to fix
one would delete their half. The hazard is a property of the PAIR, so it needs a home of its own; the four
now `relates` here.

## The general point, worth more than the two instances

A backlog audited task-by-task cannot surface conflicts between tasks. Both of these were invisible for as
long as each body was read alone and became obvious in one pass over the whole slice. If this backlog is
handed to another manager, that pass is what protects them — priority ordering will not.
