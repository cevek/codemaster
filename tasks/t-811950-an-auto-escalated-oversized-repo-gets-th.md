---
id: t-811950
title: An auto-escalated OVERSIZED repo gets the DEFAULT ~4 GB child heap — the escalation isolates the OOM instead of surviving it, so every reference question on a 6k-file monorepo is unanswerable
status: backlog
priority: high
parent: t-338692
type: bug
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-163532
  - t-187018
  - t-396905
  - t-544207
surface:
  - src/daemon/escalate.ts
  - src/daemon/fork-engine.ts
audience: external
evidence: measured
created: '2026-07-30T11:17:14.589Z'
---
## Measured

`/Users/cody/Dev/backoffice2` (pnpm monorepo, ~10 apps + packages/common, 6101 src files) auto-escalates to
`process` isolation (6101 > `searchWarmMaxFiles` 4000). Every checker-backed op then dies:

    FAIL tool=oom — … isolated engine process ran out of memory (code=null signal=SIGABRT)

The relayed child fatal dump (`~/.codemaster/backoffice2-088897ca/child-stderr.log`) names the ceiling it
died at — three separate pids, same shape:

    30607 ms: Mark-Compact 4048.0 (4140.6) -> 4033.6 (4142.3) MB … allocation failure
    FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory

So the ceiling is **~4144 MB — Node's own default**, and the death is at 25–31 s, i.e. inside the PROGRAM
BUILD, not the query. It fails identically when addressed by an exact `symbolId` (no candidate page, no
name ranking) and even for `source`, i.e. "print these two declarations".

## The defect

`daemon.maxOldSpaceMB` defaults to "≥ Node's own ~4 GB" (ARCHITECTURE §19). Auto-escalation
(`escalate.ts`) fires precisely BECAUSE the repo was measured oversized — and then hands that child the
same heap a normal one gets. The escalation therefore converts "OOM kills the daemon" into "OOM kills the
op honestly", which defends §1/§3 at ZERO capability: the machine has RAM to spare and the answer was
reachable, but nothing raises the ceiling.

The oversized-ness that TRIGGERED the escalation is exactly the signal the child's ceiling should scale
with (and it is already computed — `estimateSourceFileCount`).

## Scope

- Decide the ceiling from the escalation's OWN measurement (+ machine RAM as the upper bound), rather
  than a fixed default. An honest cap is still a cap: over it, refuse — but refuse at a ceiling that
  reflects the box, not one 4 GB below it.
- `t-187018` is the adjacent ask (no per-call / per-session LEVER to set it); this one is about the
  DEFAULT being wrong for the one case we already know is oversized. Both are needed: a caller inside
  someone else's repo can set neither today.
- Verify on backoffice2 by measurement, not by reasoning: raise the ceiling, re-run the three
  `find_usages` calls, record peak RSS + wall-clock. If ~6 GB answers, the whole class closes for this
  repo shape.
