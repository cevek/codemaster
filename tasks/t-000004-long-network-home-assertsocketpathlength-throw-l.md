---
id: t-000004
title: long/network home → `assertSocketPathLength` throw lands in discarded daemon stderr
status: backlog
priority: low
type: bug
complexity: S
area: platform
created: '2026-07-08T00:00:03.000Z'
---
**long/network home → `assertSocketPathLength` throw lands in discarded daemon stderr** on
the bridge/spawn path — the user sees only a silent in-process fallback, no message.
Pre-existing. Surface the actionable "home too long" error to the client. `bug`·`low`·`cx:S`
