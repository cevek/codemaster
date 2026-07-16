---
id: t-095661
title: 'never-hang defense-in-depth: worker_threads breadcrumb watchdog (in-process) + §9 daemon kill-on-deadline + getppid poll backstop'
status: backlog
priority: high
parent: t-895142
depends_on:
  - t-368812
tags:
  - platform
type: feat
complexity: L
area: platform
created: '2026-07-16T11:06:41.218Z'
---
**Follows t-368812 (the root fix).** Defense-in-depth so a FUTURE sync-wedge (any unbounded loop we haven't found) is caught + diagnosed instead of spinning forever. Empirically established on the live wedge (parent t-895142): signal-based diagnostics are USELESS against a sync-spin — `--report-on-signal` neutralizes default-terminate yet the report is never written (uv_signal serviced on the blocked loop; waited 6+ min); unhandled `SIGUSR2` DOES default-kill a wedged process.

**In-process (`mcp --in-process`) — the only option (no external killer):** a `worker_threads` watchdog reading a **SharedArrayBuffer breadcrumb** the main thread stamps cheaply before each heavy op (`current-op + args + phase + start-time`). On heartbeat-miss the worker writes THAT breadcrumb to `~/.codemaster/stalls/<ts>.json` then `process.abort()`. This is the honest form of the "dump file" ask: a JS stack cannot be captured from a wedged thread, but the breadcrumb tells you WHAT was running ("walkFiles(/tmp) started 340s ago") — the actual diagnostic value. Threshold generous (~5 min, per §1 no legit op approaches it) to avoid false-positives on legit-slow.

**Production/daemon path:** the §9 orchestrator hard guarantee already earmarked in §2 — process-mode engine isolation + kill-on-deadline: the orchestrator SIGKILLs the wedged child by PID regardless of its blocked loop. Advance it (don't reinvent).

**Cheap backstop (fold in here):** a `getppid()===1` poll in the in-process/bridge loop → exit when orphaned (the SIGTERM handler at `mcp/server.ts:155` + stdin-EOF already work once the loop isn't wedged; these A/C fixes are near-moot after t-368812 but the getppid poll is a cheap belt).

Also: fire the stall breadcrumb on the §19 cancellable-deadline path too (the more common partial-stall leaves a diagnostic).
