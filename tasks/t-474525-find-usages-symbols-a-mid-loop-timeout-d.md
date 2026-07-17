---
id: t-474525
title: 'find_usages symbols:[…]: a mid-loop timeout discards completed targets'
status: backlog
priority: low
parent: t-031282
tags:
  - deadline
  - platform
type: perf
complexity: S
area: impact-usages
created: '2026-07-17T00:53:45.523Z'
---
**find_usages `symbols:[…]`: a mid-loop timeout discards completed targets** — the
multi-target path shares one cumulative `ctx.deadline` across the per-symbol loop. When it
expires on target K, the `DeadlineExceededError` propagates to the op's outer catch and the
WHOLE op returns `ToolFailure{tool:'timeout'}` — honest (never a false-complete) but it
drops the K-1 targets already resolved.

This is an honest partial-gap, not a lie. Improvement: catch the timeout INSIDE the loop,
keep the completed target sections, and return `partial(completed, {tool:'timeout'})` naming
the un-scanned symbols — mirroring impact/find_unused_exports' accumulated-partial shape.
Distinct from the SINGLE-target monolithic case, which correctly stays a no-data
`ToolFailure` (empty ≠ "0 usages", §3.4).

`platform`·`deadline`·`low`·`cx:S`
