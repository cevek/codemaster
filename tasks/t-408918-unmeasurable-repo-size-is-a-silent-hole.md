---
id: t-408918
title: 'Unmeasurable repo size is a silent hole: neither escalation nor the fan-out guard acts, so an oversized non-git workspace still warms in the daemon heap'
status: backlog
priority: high
tags:
  - platform
type: bug
complexity: M
area: platform
created: '2026-07-27T23:06:01.718Z'
---
Both halves of the OOM defence fall through on the SAME correlated failure — a size estimate that cannot be taken (non-git root, `git` absent from the daemon's PATH, an `ls-files` timeout on a huge tree, submodule breakage):

- `src/daemon/escalate.ts` — estimate fails → `reason:'estimate-failed'`, no escalation ("never escalate on unknown").
- `src/ops/guard/semantic-fanout-guard.ts` — estimate fails → no refusal ("the guard is an optimization, never a correctness gate").

Each half is defensible alone; together they are exactly the scenario the defence exists for: an oversized workspace warms the LS in the singleton daemon's own heap, where an OOM is uncatchable and takes every workspace down.

Not a regression (the guard's fall-through predates auto-escalation) — but auto-escalation is what makes it the LAST hole in the class, so it should be closed deliberately.

Options, none free:
- escalate on unknown (unknown ⇒ expensive; a fork is far cheaper than an OOM) — costs a child process for every small non-git workspace;
- a bounded non-git file count (the `walkFiles` fallback the freshness path already uses) as a second measurement source, so "unknown" becomes rare;
- refuse the heavy fan-out when size is unknown — the strongest, but over-refuses every small non-git workspace, which §3 rates expensive.

Whatever is chosen, the two halves must agree on it — a split decision reproduces this hole.

## Direction (decided)

Prefer ESCALATION on an unmeasurable size, not refusal: process-mode is safe by default and the cost is one extra fork on a small non-git workspace, whereas refusing hits EVERY non-git workspace — including the test fixtures.

This inverts the current default, so it needs measuring before it ships: how many test fixtures move into a forked child, and what that does to suite wall-clock. Hence a track of its own, not a tail on t-754922.
