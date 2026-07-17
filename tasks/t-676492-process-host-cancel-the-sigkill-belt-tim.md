---
id: t-676492
title: 'process-host: cancel the SIGKILL belt-timer on prompt child exit'
status: backlog
priority: low
tags:
  - daemon
  - nit
  - process-isolation
created: '2026-07-17T00:52:06.411Z'
---
The `KILL_BELT_MS` belt timer added in t-000052 (process-host.ts, on the per-request deadline
and the dispose SIGKILL-fallback) is never cancelled. On the NORMAL timeout path (SIGKILL →
prompt `'exit'` → `markDead` on exit), the belt still fires ~5s later as an **idempotent no-op**
(the `dead` guard makes it harmless: no hang, no double-`onExit`, no wrong result). The only cost
is a dangling closure held ~5s per killed child on a long-lived daemon; the systemClock timer is
`unref`ed so it never holds the process open.

Fix (optional, correctness-neutral): capture each belt's `CancelTimer` and clear it inside
`markDead`. Deferred as a trifle — flagged by the t-000052 re-verify bug-reviewer as `[nit], does
not block`; tracking the belt cancels adds bookkeeping that arguably costs more than the leak saves.
