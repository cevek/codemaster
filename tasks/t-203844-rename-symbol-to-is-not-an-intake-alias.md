---
id: t-203844
title: "rename_symbol: 'to' is not an intake alias for newName — the #1 spontaneous spelling fails on first call"
status: backlog
priority: medium
parent: t-826059
type: dx
complexity: S
area: platform
source: dogfood-jul
surface:
  - src/ops/intake
audience: external
evidence: repro
created: '2026-07-30T19:58:24.138Z'
---
`rename_symbol {name:'X', to:'Y'}` → `bad_args`. The error is good (pointed, ships a copyable valid shape),
but "rename X **to** Y" is the natural phrasing, so this is a guaranteed first-call failure for every new
agent — and the §7 intake normalizer already maps `symbol`→`name`, `path`→`module`, `max_results`→`limit`.

Add `to`→`newName` (and consider `rename`→`newName`) to the per-op alias table. Cheap, and it removes a
failure that costs a round trip precisely at the moment an agent is deciding whether the tool is worth using
— which is this epic's whole subject.
