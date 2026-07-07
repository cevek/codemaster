---
id: t-000110
title: 'DRY: consolidate the two mutating-op envelope builders'
status: backlog
priority: low
type: dx
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:49.000Z'
---
**DRY: consolidate the two mutating-op envelope builders** — `refactor-apply.ts` (flat-edit) and
`refactor-plan-apply.ts` (move/extract) encode the same §2.10 gate/envelope/post-typecheck
near-verbatim. Both verified correct + covered; extract a shared scaffold when the next §2.10
change forces editing both. `dx`·`low`·`cx:M`
