---
id: t-000057
title: transport.connect()` has no explicit timeout
status: backlog
priority: low
type: perf
complexity: S
area: platform
created: '2026-07-08T00:00:56.000Z'
---
**`transport.connect()` has no explicit timeout** (`support/transport/unix-socket.ts` /
`connect-or-spawn.ts`) — it relies on a fast kernel resolve of a unix socket (a connect to a
live or absent socket settles immediately; carried from the daemon-singleton {2a+2b} review).
The management verbs and the bridge bound their REPLY/spawn-wait, not the connect itself, so a
pathological connect that neither resolves nor rejects would sit unbounded. Add a bounded
connect (deadline → reject) if it ever hangs in the field. `perf`·`low`·`cx:S`
