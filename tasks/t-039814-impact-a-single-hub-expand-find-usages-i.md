---
id: t-039814
title: 'impact: a single hub-expand find_usages is not wall-clock bounded'
status: backlog
priority: low
parent: t-031282
tags:
  - deadline
  - platform
type: perf
complexity: M
area: impact-usages
created: '2026-07-17T00:53:39.173Z'
---
**impact: a single hub-expand `find_usages` is not wall-clock bounded** — `impact`'s BFS
polls the cooperative deadline at LOOP boundaries (before each `expand`), which bounds the
NUMBER of expansions but not the DURATION of any one. A single hub node with ~10k
references makes one `expand` (a `ts.findUsages` call) run unbounded, since impact's
internal `ts.findUsages({symbolId}, options)` calls deliberately pass NO deadline (so a
cancelled expand never surfaces as a mid-BFS `ts-ls` error).

Fix idea: thread `ctx.deadline` into impact's per-node `find_usages` too, and translate a
`DeadlineExceededError` from an expand into the same `by:'timeout'` partial (keeping the
accumulated closure) rather than a `ts-ls` failure. Requires the closure/op to distinguish
a timeout-cancel from a real LS fault.

`platform`·`deadline`·`low`·`cx:M`
