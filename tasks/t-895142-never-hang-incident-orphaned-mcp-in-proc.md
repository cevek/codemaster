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

Directly violates the north-star §1 invariant ("never hang — the worst failure; halts the agent entirely").

**ROOT CAUSE (found + reproduced live, sample-profiled).** `src/support/fs/walk.ts` `visit()`: `statSync` (walk.ts:48) FOLLOWS symlinks, and the recursion (walk.ts:54) has NO realpath-visited-set and NO depth bound. A dir with K≥2 symlinks to an ancestor explodes combinatorially — every virtual path re-walks the tree until ELOOP at ~32 hops, so ~K^32 paths. Measured: 1 parent-link → ELOOP-truncated, 4 ms; 2 links → 196 605 file records off 3 real files, 12.4 s; 4 links → practically infinite 100 % CPU spin. Memory also grows unboundedly (`files`/`errors` accumulate per virtual path) — secondary OOM risk.

**Reach:** per-QUERY on any non-git root via `createFreshnessGuard.checkWalk` (`src/daemon/freshness.ts:183`) — the first `tools/call` on `cwd=/private/tmp` spins forever; also reachable via `walkRepoFiles` discovery (`src/plugins/ts/program/discover.ts:193`), scss/i18n/schema plugin init, `defaultSourceFingerprint`. Live wedge stack (macOS `sample`): `uv OnClose (git child) → await checkGit resolve → checkWalk → deep self-recursion of visit`.

**Incident chain:** grok CLI runs (`cd /tmp && grok …`, myclaude session 118c1387 "grok", started 14:20:45) mount the GLOBAL `~/.claude.json` codemaster server (`mcp --in-process`) with inherited `cwd=/private/tmp` (grok per-project MCP caches at `~/.grok/projects/private-tmp/mcps/codemaster/` prove prior mounts); /tmp held a symlink-cycle/huge tree at the time; the first call wedged the sync walk; grok exited → orphans (PPID 1), 100 % CPU from birth (ps CPU-time ≈ wall-time), SIGTERM-deaf because the handler (mcp/server.ts:155) sits on the blocked loop.

**Signal behavior (watchdog design input):** unhandled SIGUSR2 KILLS the wedged process (OS default — no JS handler); with `--report-on-signal` the flag NEUTRALIZES that default yet never writes a report (uv_signal is serviced on the blocked loop) — signal-based diagnostics are useless against a sync spin; a `worker_threads` watchdog or external killer is required. `timeout`(SIGTERM) also fails to kill it.

**Repro:** `mkdir -p /tmp/cml/pkg && cd /tmp/cml/pkg && printf '{}' >tsconfig.json && printf '{"name":"x"}' >package.json && echo 'export const X=1;' >a.ts && for i in 1 2 3 4; do ln -s /private/tmp/cml back$i; done` → `cd /private/tmp && node <repo>/src/bin.ts mcp --in-process` → initialize + any tools/call → permanent 100 % CPU. (Remove the dir after — it mines EVERY later /tmp-cwd mount.)

**Fix direction:** `lstatSync` and skip symlinked dirs (or `realpath`+visited-set if following is wanted) + depth bound + total-entry cap in `walkFiles`; walk-mode freshness must not re-walk an unbounded foreign tree per query (cap + honest `ToolFailure{timeout}`).

**Root-cause structure (load-bearing): B is the root; A and C are downstream.** A synchronous busy-loop (100% CPU 45 min = a spin, not load) blocks the event loop, so the process cannot process SIGTERM, stdin-EOF, or parent-death (all serviced on the blocked loop). So the orphan/SIGTERM-deafness are *symptoms* of the wedge, not independent bugs.

**Mode split (the incident is the `--in-process` dev/dogfood path, which has no external killer):**
- Production/daemon path: the hard guarantee is the §9 process-mode engine-isolation + kill-on-deadline already earmarked in §2 for "a wedged sync loop holding the socket" — orchestrator SIGKILLs the child by PID regardless of its blocked loop.
- `--in-process`: a `worker_threads` self-watchdog (heartbeat → `process.abort()` on miss) is the only option; best-effort.

**Two-processes-at-once is EXPECTED** for in-process (no singleton; bind-or-connect convergence, §19) — not a separate bug (confirm the client isn't double-spawning for another reason, but don't chase it as the defect).

Subtasks: repro+root-cause (B), daemon kill-on-deadline, in-process worker-watchdog + diagnostic dump, orphan-exit + SIGTERM (A/C).
