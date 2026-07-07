---
id: t-000053
title: convergence hardening — liveness-probe-before-unlink / bind-first
status: backlog
priority: low
type: bug
complexity: S
area: platform
created: '2026-07-08T00:00:52.000Z'
---
**convergence hardening — liveness-probe-before-unlink / bind-first** (`connect-or-spawn.ts`).
The bridge re-probes before unlinking a socket (§19), so it only clears a stale file — but a
narrow residual race remains: a daemon another bridge binds in the microsecond after the
re-probe could be unlinked → a transient split-brain (two daemons). It self-heals (the orphan
idle-exits by TTL). A bind-first scheme (the spawned daemon owns the unlink+bind atomically, the
bridge never unlinks) would close it fully. `bug`·`low`·`cx:S`
