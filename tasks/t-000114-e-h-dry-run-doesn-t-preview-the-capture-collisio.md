---
id: t-000114
title: E-h — dry-run doesn't preview the capture/collision/dirty REFUSAL verdict
status: backlog
priority: medium
type: dx
complexity: M
area: transaction
created: '2026-07-08T00:01:53.000Z'
---
**E-h — dry-run doesn't preview the capture/collision/dirty REFUSAL verdict** — the shared
dry-run branch emits `captures` rows but not `applied:false`+`reason` (apply-only). Pre-existing
across all mutating ops; a predictive `wouldApply:false`+reason would close it uniformly.
`dx`·`med`·`cx:M`
