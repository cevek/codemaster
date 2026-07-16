---
id: t-895142
title: 'never-hang incident: orphaned `mcp --in-process` server spins at 100% CPU (SIGTERM-deaf, reparented to launchd) — §1 violation'
status: backlog
priority: urgent
tags:
  - platform
type: bug
complexity: L
area: platform
created: '2026-07-16T10:20:24.271Z'
---
**Incident (macOS Darwin 25.0.0, observed 2026-07-16).** Two `node src/bin.ts mcp --in-process` processes (PID 44877/44967, spawned 14:21:32/34) each burned ~100% CPU **continuously for 46 min**, `parent=1` (launchd — the MCP host that spawned them had exited, leaving them orphaned), `cwd=/private/tmp`. **Deaf to SIGTERM** (only `kill -9` worked).

Directly violates the north-star §1 invariant ("never hang — the worst failure; halts the agent entirely"). Not reliably reproducible yet.

**Root-cause structure (load-bearing): B is the root; A and C are downstream.** A synchronous busy-loop (100% CPU 45 min = a spin, not load) blocks the event loop, so the process cannot process SIGTERM, stdin-EOF, or parent-death (all serviced on the blocked loop). So the orphan/SIGTERM-deafness are *symptoms* of the wedge, not independent bugs.

**Mode split (the incident is the `--in-process` dev/dogfood path, which has no external killer):**
- Production/daemon path: the hard guarantee is the §9 process-mode engine-isolation + kill-on-deadline already earmarked in §2 for "a wedged sync loop holding the socket" — orchestrator SIGKILLs the child by PID regardless of its blocked loop.
- `--in-process`: a `worker_threads` self-watchdog (heartbeat → `process.abort()` on miss) is the only option; best-effort.

**Two-processes-at-once is EXPECTED** for in-process (no singleton; bind-or-connect convergence, §19) — not a separate bug (confirm the client isn't double-spawning for another reason, but don't chase it as the defect).

Subtasks: repro+root-cause (B), daemon kill-on-deadline, in-process worker-watchdog + diagnostic dump, orphan-exit + SIGTERM (A/C).
