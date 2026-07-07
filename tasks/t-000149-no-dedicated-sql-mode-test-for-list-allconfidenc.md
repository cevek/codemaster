---
id: t-000149
title: no dedicated sql-mode test for `list` `allConfidence` backfill
status: backlog
priority: low
type: dx
complexity: S
area: full-density
created: '2026-07-08T00:02:28.000Z'
---
**no dedicated sql-mode test for `list` `allConfidence` backfill** — `listTable.rows` fills
`confidence` from `allConfidence` when hoisted (verified by reading); mirrors `allKind`/
`allProvenance` which also lack a dedicated sql test. Add one. `dx`·`low`·`cx:S`
