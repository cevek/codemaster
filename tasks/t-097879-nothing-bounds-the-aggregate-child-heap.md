---
id: t-097879
title: "Nothing bounds the AGGREGATE child heap: N concurrently-heavy escalated engines can each claim the box-derived ceiling, and an OS/cgroup kill then reports 'crash' + 'unproven-program-build' instead of the honest oom"
status: backlog
priority: high
type: bug
complexity: M
area: platform
relates:
  - t-338692
  - t-811950
surface:
  - src/daemon/heap-ceiling.ts
  - src/daemon/orchestrator.ts
  - src/daemon/process-host.ts
audience: external
evidence: measured
created: '2026-07-30T12:13:24.494Z'
---
## What is PROVEN (read off code + measurement, not reasoning)

- **The aggregate is unbounded.** The engine budget is a COUNT — `DEFAULT_MAX_ENGINES = 8`
  (`src/daemon/orchestrator.ts`) — and the cross-engine RSS governor is explicitly roadmap
  (ARCHITECTURE §9). Nothing sums the children's memory.
- **The per-child ceiling is now box-derived**: config verbatim, else half the box within
  [4096, 8192] MB (`src/daemon/heap-ceiling.ts`). On a 32 GB box that is 8192 per child.
- **The arithmetic of reachability changed with t-811950, in the wrong direction.** Four
  concurrently-heavy escalated children at the old fixed 4096 could not exceed a 32 GB box
  (4 × 4096 = 16 GB); at 8192 they meet it exactly (4 × 8192 = 32 GB). The measured live need of one
  checker-backed `find_usages` on a 6.1k-file monorepo is ~5.2 GB (t-811950), so two such children
  already claim ~10.4 GB and eight escalated workspaces are within the count budget.
- **The verdict lies in the recognizable direction.** `isOom` (`src/daemon/process-host.ts`) matches
  only `code === 134 || signal === 'SIGABRT'` — V8's own heap-OOM signature. An OS/cgroup kill under
  memory pressure arrives as `signal='SIGKILL'`, so the SAME underlying cause reports `crash` +
  `outOfReach: 'unproven-program-build'` where the V8 path reports `oom` + `'any-program-build'`. The
  claim an agent switches on therefore depends on WHICH memory wall was hit first — a never-lie
  defect (§3.4/§3.6), not an ergonomic one: the weaker verdict is the one the aggregate path yields.
- **The cgroup half is proven too.** A limit below ~8 GB is reduced into the box reading
  (`boxMemoryBytes`) and then swallowed by the [4096, …] floor, so a 2 GB container gets a 4096 MB
  ceiling and stays kernel-killable. The floor is deliberately not carved out for it (half of a small
  container is a heap where repos that fit today would begin failing) — this is the residual that
  choice leaves.

## What is UNVERIFIED

Only the kill itself: no two-engine aggregate exhaustion was reproduced, so the SIGKILL→`crash`
path is read from the signature check rather than observed. Everything above is code + the t-811950
measurements.

## What a fix has to decide

Either bound the aggregate (the roadmap RSS governor, or scale the per-child fraction by the live
engine count) or widen the OOM signature so a kernel kill under memory pressure is not reported as an
unexplained crash — the second is cheap and closes the honesty half on its own, independent of any
memory policy.
