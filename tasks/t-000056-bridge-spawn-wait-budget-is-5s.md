---
id: t-000056
title: bridge spawn-wait budget is 5s
status: backlog
priority: low
type: perf
complexity: S
area: platform
created: '2026-07-08T00:00:55.000Z'
---
**bridge spawn-wait budget is 5s** (`connect-or-spawn.ts`) — a cold daemon start slower than 5s
makes the bridge fall back to in-process (safe + self-correcting on the next launch, but loses
amortization for that session). Revisit if cold starts approach it. `perf`·`low`·`cx:S`
