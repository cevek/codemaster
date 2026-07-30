---
id: t-097879
title: "Nothing bounds the AGGREGATE child heap: N concurrently-heavy escalated engines can each claim the box-derived ceiling, and an OS/cgroup kill then reports 'crash' + 'unproven-program-build' instead of the honest oom"
status: backlog
priority: medium
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
evidence: unverified
created: '2026-07-30T12:13:24.494Z'
---
## The gap

A `process`-mode child's heap ceiling is per-child (`src/daemon/heap-ceiling.ts`: config verbatim, else
half the box within [4096, 8192] MB). The engine budget is a COUNT (`DEFAULT_MAX_ENGINES = 8`,
`src/daemon/orchestrator.ts`) — the cross-engine RSS governor is roadmap (ARCHITECTURE §9) — so nothing
bounds the sum. On a 16 GB box two escalated workspaces (the documented worktree-spam workflow: two
worktrees of one 6.1k-file monorepo) each hold an 8192 MB ceiling and each need the measured ~5.2 GB live
for one checker-backed query.

UNVERIFIED: the aggregate kill itself is not reproduced here — the per-child numbers and the `isOom`
signature below are read off measurement and code, the two-engine collision is reasoned from them.

## Why it is an HONESTY defect, not only pressure

Exceeding the box is an OS/cgroup kill, which arrives as `signal='SIGKILL'`. `isOom` in
`src/daemon/process-host.ts` recognizes only `code === 134 || signal === 'SIGABRT'` (the V8 heap-OOM
signature), so the failure reports `crash` and picks `outOfReach: 'unproven-program-build'` — where the
same underlying cause via V8's own limit reports `oom` + `'any-program-build'`. The verdict an agent acts
on therefore depends on WHICH memory wall was hit first, and the aggregate path yields the weaker,
less accurate one.

Same shape from the other end: a cgroup limit BELOW ~8 GB is reduced into the box reading
(`boxMemoryBytes`) but then swallowed by the [4096, …] floor, so a 2 GB container still gets a 4096 MB
ceiling and is still kernel-killable. The floor is deliberately not carved out for it (half of a small
container is a heap where repos that fit today would begin failing) — which leaves exactly this residual.

## What a fix has to decide

Either bound the aggregate (the roadmap RSS governor, or scale the per-child fraction by the live engine
count) or widen the OOM signature so a kernel kill under memory pressure is not reported as an
unexplained crash — the second is cheap and closes the honesty half on its own.
