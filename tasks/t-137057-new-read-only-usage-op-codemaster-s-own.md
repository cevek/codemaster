---
id: t-137057
title: New read-only `usage` op — codemaster's own telemetry is the most decisive debugging surface it has and is unreachable through the tool (manual jsonl only); table-bearing under sql, with the two honesty constraints an ad-hoc reader gets wrong
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-034931
  - t-048595
  - t-137128
  - t-287742
  - t-469353
  - t-810757
  - t-954198
surface:
  - ops
  - support
audience: internal
evidence: measured
created: '2026-07-28T08:05:45.571Z'
---
From worker 97c0652d's dogfood report, and independently confirmed by this manager's own session.

`~/.codemaster/usage/{success,fail}.jsonl` turned out to be the single most decisive instrument of the
whole wave: it is what falsified a premise that had already been escalated to an urgent task and reported
to the user twice as measured fact ("the auto-escalated child grinds ~6m40s"). The refutation was one
query away — no record in the entire history exceeds 47 s — and it took hand-rolled `jq` to get, because
the tool cannot read its own telemetry.

So the instrument that decides whether a codemaster claim is true is the one surface codemaster does not
expose. Every consumer today hand-parses jsonl, which is exactly where the honesty rules get dropped.

Ask: a read-only `usage` op, table-bearing so it composes under `batch + sql` (§11) — the data is already
row-shaped, so the sql evaluator carries the aggregation for free, and questions like "slowest ops by
repo", "fail rate by tool since X", "which op was in flight when the daemon died" become one call.

Two honesty constraints are NOT optional, because an ad-hoc reader violates both today:

1. **Counting calls requires `outcome === undefined && origin === undefined`.** A fatal legitimately
   produces TWO rows from two processes (the agent-facing accounting record and the daemon's promoted
   breadcrumb, discriminated by `origin` — t-305430). A naive `wc -l` double-counts exactly the events
   that matter most.
2. **Every count is a LOWER BOUND** — the log rotates and is size-capped, and the promotion pass is
   itself bounded (§3.4). An op that reports a total without saying so would be the silent-truncation lie
   in a new place.

Correlation of the pair is `cwd + ops`, never `tool` (on the daemon-side view `tool` is derived — see
t-954198 for the residual ambiguity).

Related: t-034931 (the pair is only correlatable after the next logger start), t-933867 (the sibling
"codemaster cannot answer questions about itself" finding).
