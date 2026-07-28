---
id: t-000021
title: new QueryClient()` receiver
status: backlog
priority: low
type: feat
complexity: S
area: framework
relates:
  - t-000020
  - t-000133
surface:
  - plugins/react-query
  - plugins/ts
audience: external
evidence: repro
created: '2026-07-08T00:00:20.000Z'
---
**`new QueryClient()` receiver** — the invalidate-family methods match a `useQueryClient()`
binding only; a `const qc = new QueryClient()` receiver is not matched (deferred to W5-a). `feat`·`low`·`cx:S`

**Related:** t-000133 is W5-a, the ts-seam half of this same receiver gap (`CallMatchSpec.constructors`). The two bodies describe one defect at two layers — candidates for a merge, not a dependency: t-000133 records that react-query can cover it in its own policy, so neither blocks the other.
