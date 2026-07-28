---
id: t-803574
title: find_unused_props reports `declared` as the SHOWN member count under a bitten cap (500 while 601 are declared), with no structured floor field
status: backlog
priority: low
tags:
  - dogfood
  - honesty
type: bug
complexity: S
area: render
created: '2026-07-28T18:10:07.094Z'
---
`src/ops/find-unused-props.ts` emits `declared: view.declaredCount`, which is
`declared.members.length` — the members that SURVIVED `MEMBER_CAP` (500), not the number the
component declares. On a component with 601 apparent members the answer reads `declared: 500`
while 601 are declared.

Pre-existing (identical at the range's base commit), and partly mitigated since: a bitten cap now
demotes the whole set to `partial` and its note carries both numbers (`declared-member set capped
at 500/601, upstream of the view filters — … every count here is a floor`), and that note rides
the sql `table` `notes` channel. So a reader who reads the prose is not misled.

What is still missing is the STRUCTURED signal: a `format:'json'` / sql consumer reading
`declared` alone gets a number that is a floor with nothing saying so — the same gap
`hiddenExternalIsLowerBound` closes for the hidden count.

Fix: carry the true total (the ts seam already reports it as `truncated.total`) — either as
`declared` with a `declaredIsLowerBound`-style marker, or as an explicit `declaredTotal` beside
the shown count. Whichever, the two numbers must not be conflatable.
