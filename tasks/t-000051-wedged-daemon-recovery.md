---
id: t-000051
title: Wedged-daemon recovery
status: done
priority: medium
parent: t-031282
type: bug
complexity: L
area: platform
created: '2026-07-08T00:00:50.000Z'
---
**Wedged-daemon recovery** — the singleton (spec-daemon-singleton, shipped) reaps orphans via
the daemon's idle-exit + the bridge's per-request reply deadline, but a **permanently wedged
daemon** (accepts connections but never replies — a wedged synchronous loop holding the socket)
is not reaped: its own idle loop is wedged too. Bridges fail honestly (reply-deadline →
`ToolFailure`) and the agent falls back, but the daemon process lingers until killed. Needs
process-mode engine isolation + kill-on-deadline (below) — the supervising process kills a child
that overran. Optional cheaper interim: after N consecutive bridge reply-timeouts, trigger a
daemon liveness re-probe / SIGTERM. `bug`·`med`·`cx:L`
