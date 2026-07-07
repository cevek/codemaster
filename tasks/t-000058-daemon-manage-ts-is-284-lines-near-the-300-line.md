---
id: t-000058
title: daemon/manage.ts` is ~284 lines — near the 300 line-cap
status: backlog
priority: low
type: dx
complexity: S
area: platform
created: '2026-07-08T00:00:57.000Z'
---
**`daemon/manage.ts` is ~284 lines — near the 300 line-cap** (like `imports.ts`). No issue today,
but the next verb / wording change is the split signal: factor the wire helpers (`awaitReply` /
`awaitClose` / envelope builders / `fmtUptime`) into a sibling file. `dx`·`low`·`cx:S`
