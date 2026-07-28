---
id: t-460393
title: "process-mode child logging residuals: the parent's relay ignores debug.logMaxMB, carries no timestamps, and a failed auto-escalated spawn can still leave two writers on debug.log"
status: backlog
priority: low
tags:
  - dogfood
  - platform
type: dx
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-034931
  - t-163532
surface:
  - daemon
  - support
audience: internal
evidence: repro
created: '2026-07-28T07:34:28.471Z'
---
Residuals around the engine child's stderr relay (`daemon/child-stderr-relay.ts`, wired in
`daemon/fork-engine.ts`), each small and independent. None is a lie; all are ergonomics or a
pre-existing race the relay work surfaced.

1. **`config.debug.logMaxMB` is ignored for `child-stderr.log`.** `attachRepoLogSink` honors it;
   `fork-engine.ts` has no config in scope and takes the sink's 16 MB default. A user who capped
   their disk at 1 MB gets a 16 MB neighbour file. Needs the value threaded through
   `ForkEngineOpts` (i.e. from `process-host-factory.ts`, which does hold config).

2. **Relayed lines carry no timestamp**, while every line in the adjacent `debug.log` does — the
   two cannot be correlated in time when reading a crash.

3. **`host-build.ts:79-81` states an invariant that is now incomplete and, on one path, false.**
   Incomplete: the orchestrator DOES write in the repo log dir now (the neighbouring
   `child-stderr.log`), while the comment reads as "the parent writes nothing there". False on the
   auto-escalated FAILED-spawn path: `createProcessHost` returns `ok:false` after an async
   `SIGKILL`, the child has already attached its own rotating sink over `debug.log`, and the
   fallback continues to `host-build.ts:109` where the parent attaches one over the SAME file.
   The window is milliseconds and predates the relay work — but the comment should say what is
   true.

4. **A child that dies at import time leaves its stack in `child-stderr.log`, and the startup
   failure message does not name that path** (`process-host.ts`: "engine child exited during
   startup (code=… signal=…)"). The diagnostic is kept but unreferenced (§3.6 — say where it is).

5. **Two independent parents (a CLI one-shot plus the daemon) can write one `child-stderr.log`**,
   the same shape that already exists for `debug.log`. Only a concern if per-process log ownership
   is ever tightened.

Boundary note: 1, 3 and 4 touch `daemon/host-build.ts` / `process-host-factory.ts` /
`process-host.ts`, which were out of the relay change's surface.
