---
id: t-904175
title: importers_of / member_usages are not wall-clock bounded
status: backlog
priority: low
parent: t-031282
tags:
  - deadline
  - platform
type: perf
complexity: M
area: impact-usages
created: '2026-07-17T00:53:51.194Z'
---
**importers_of / member_usages are not wall-clock bounded** — the cooperative
`HostCancellationToken` deadline is wired into `find_usages` and `search_symbol` (the
headline monolithic-LS-call ops). Other LS-heavy read ops that ride the same
`findReferences` primitive — `importers_of`, `member_usages`, and `referenceSpans`
(text-overlay) — do NOT yet thread `ctx.deadline` into `host.withDeadline`, so a
pathological whole-repo call on them can still spin past the budget.

Fix: thread `ctx.deadline` through their plugin methods and wrap the LS call in
`host.withDeadline`, mapping `DeadlineExceededError` → `ToolFailure{tool:'timeout'}` (no
data, same as find_usages). The mechanism (`plugins/ts/cancellation.ts`) already exists;
this is fan-out wiring.

`platform`·`deadline`·`low`·`cx:M`
