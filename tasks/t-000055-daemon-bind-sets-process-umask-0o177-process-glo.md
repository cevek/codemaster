---
id: t-000055
title: "daemon bind sets `process.umask(0o177)` process-globally"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: platform
created: '2026-07-08T00:00:54.000Z'
---
**daemon bind sets `process.umask(0o177)` process-globally** for the bind window
(`support/transport/unix-socket.ts`) — safe today (no other startup I/O; plugins are lazy), but
a future concurrent startup file-write would inherit 0600. Prefer a per-socket mode at create if
a portable API appears. `bug`·`low`·`cx:S`
