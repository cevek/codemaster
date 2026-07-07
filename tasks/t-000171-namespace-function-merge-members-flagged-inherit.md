---
id: t-000171
title: "namespace/function-merge members flagged `inherited=true"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:50.000Z'
---
**namespace/function-merge members flagged `inherited=true`** — `isInherited` (type-expand.ts:155)
= "decl in a different node", which is technically true for a fn+namespace merge but reads as
misleading. Verify the label is wanted for merges before acting. `bug`·`low`·`cx:S`
