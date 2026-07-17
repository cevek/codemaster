---
id: t-350294
title: Install the breadcrumb-watchdog inside the process-mode engine-child (heavy sync now lives in the fork)
status: backlog
priority: medium
parent: t-031282
tags:
  - platform
  - watchdog
type: feat
complexity: M
area: platform
created: '2026-07-17T01:05:45.017Z'
---
Surfaced by t-000052 (process-mode isolation) after t-095661 (watchdog) landed.

## Gap
The t-095661 breadcrumb-watchdog (worker-thread + SharedArrayBuffer beacon → SIGKILL a wedged process, ~5min) is installed on the `mcp --in-process` and `daemon serve` paths. But in **process-mode** the heavy synchronous work (the warm LS, program build, find_usages) runs in the forked `serve-engine` CHILD (`src/daemon/engine-child.ts`), which currently has ONLY the anti-orphan IPC `disconnect` self-exit — NO breadcrumb-watchdog. So a sync wedge INSIDE the child (the exact §1 hang class the watchdog exists to catch) is caught by the parent's kill-on-deadline (t-063850, when built) from OUTSIDE, but the child itself leaves no in-process breadcrumb and self-abort.

## Task
Install the breadcrumb-watchdog (reuse `src/support/watchdog/`) inside the engine-child bootstrap, so a wedge in the forked workspace process writes a stall-breadcrumb + SIGKILLs itself — the same in-process backstop the daemon/in-process paths already have. Complementary to t-063850 (external per-child SIGKILL from the orchestrator): this is the child's OWN in-process self-diagnose+kill.

Reuse the existing beacon/worker/stall-dir; wire an `installWatchdog` call in `engine-child.ts`. Determinism + real-spawn smoke per the t-095661 pattern (event-driven, isolated temp stall-dir, own pid). Heavy runs through the machine-wide test-lock (~/.codemaster-orch/with-test-lock.mjs).
