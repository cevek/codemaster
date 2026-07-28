---
id: t-278380
title: member_usages cannot answer "under WHAT CONDITION is this member touched" — the conditions:true annotation exists only on find_usages
status: backlog
priority: medium
tags:
  - agent-surface
type: feat
complexity: S
area: impact-usages
created: '2026-07-28T07:24:22.951Z'
---
`find_usages {conditions:true}` reports the enclosing conditional-branch chain per site (sql column
`condition`), which turns "where is X used" into "where is X used AND WHEN". `member_usages` answers
the same question shape for a class/type MEMBER and has no such annotation, so "which writes to
`state.flag` happen only under a feature check" still needs one read per site.

Not a dangling-surface bug: `member_usages` carries its own `MemberUsageSite` (not `UsageView`), so
nothing is half-wired — it is a capability gap.

The seam is reusable as-is: `conditionChainAt(sourceFile, offset)` in
`src/plugins/ts/call-condition-chain.ts` is position-addressed and checker-free. Work is the flag,
the view field, the table column and the honesty note (mirror find_usages: PRESENT-but-empty =
measured "no enclosing branch", ABSENT = not annotated, leading `<unstated>` = subset).
