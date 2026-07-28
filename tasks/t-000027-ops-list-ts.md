---
id: t-000027
title: ops/list.ts
status: backlog
priority: medium
type: feat
complexity: M
area: framework
relates:
  - t-000022
  - t-000024
  - t-000025
surface:
  - ops
audience: external
evidence: unverified
created: '2026-07-08T00:00:26.000Z'
---
**`ops/list.ts`** — dispatches to the plugin owning the requested registry; DAG enforcement +
per-plugin oracles. `feat`·`med`·`cx:M`

**Related:** t-000024 / t-000025 / t-000022 each declare a registry this op dispatches to, so their surface reaches an agent only through it.
