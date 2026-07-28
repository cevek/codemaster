---
id: t-823472
title: 'Two daemon-lifecycle hygiene nits: `idle.stop()` does not latch, and a bind-race loser builds a usage logger it never disposes'
status: backlog
priority: low
tags:
  - platform
type: imp
complexity: S
area: platform
relates:
  - t-000066
  - t-824810
surface:
  - common
  - daemon
audience: internal
evidence: measured
created: '2026-07-28T07:27:00.057Z'
---
Two small pre-existing rough edges surfaced while reviewing the daemon's crash-breadcrumb span. Neither is a live defect; both are "correct only by coincidence".

## 1. `idle.stop()` does not latch (`common/async/idle-exit.ts`)

`stop()` only disarms the pending timer; it does not set `fired`. On the `shutdown` envelope the handler holds an idle hold, `dispatch` calls `void shutdown()` → `idle.stop()`, and then the handler's `finally` runs `idle.leave()` → `holds === 0` → `arm()`, RE-ARMING a timer after stop. It is harmless only because `shutdown()` is guarded by `shuttingDown` and `systemClock` timers are `unref`'d.

Fix: latch in `stop()` (set `fired`, or a dedicated `stopped` flag) so a post-stop `leave()` cannot re-arm. Note the consumer contract in the file header covers two different hold models, so the fix should keep both working.

## 2. A bind-race loser builds a usage logger it never disposes (`bin.ts` `daemon serve`)

`defaultUsageLogger()` is evaluated as an ARGUMENT to `serveDaemon`, i.e. before `transport.listen()`. A daemon that loses the bind race (`EADDRINUSE`, §19 convergence) has therefore already constructed both rotating file sinks and run a promotion pass, and it exits down a path that never calls `usage.dispose()` (the throw precedes the handle's creation). Harmless — the process exits and the OS reclaims the descriptors, and the promotion is claim-by-rename so it cannot double-count — but it is work and file handles spent by a process that was never going to serve.

Measured, and NOT a startup risk: a promotion pass over 2500 breadcrumbs takes ~52 ms (`{promoted: 200, deferred: 2300}`), far inside the bridge's connect budget.

Fix: construct the logger after a successful bind, or make the loser path dispose it.
