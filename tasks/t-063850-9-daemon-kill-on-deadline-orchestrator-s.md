---
id: t-063850
title: '§9 daemon kill-on-deadline: orchestrator SIGKILLs a wedged engine child by PID (never-hang hard guarantee)'
status: backlog
priority: high
parent: t-895142
depends_on:
  - t-000052
tags:
  - platform
type: feat
complexity: M
area: platform
created: '2026-07-17T00:45:02.609Z'
---
**Backstop 3, split out of t-095661** (which shipped backstops 1+2: the in-process worker-thread breadcrumb watchdog + orphan poll). This is the PRODUCTION hard guarantee — more precise than the same-process watchdog (per-child SIGKILL, not a whole-daemon SIGKILL last resort).

**Blocked on t-000052 (process-mode engine isolation).** The kill-on-deadline backstop needs a killable child: the orchestrator spawns one child process per workspace (§2/§9), tracks its PID + a per-request deadline, and on overrun SIGKILLs THAT child by PID — bypassing its blocked event loop entirely (a wedged sync loop cannot service signals/JS handlers, established in t-895142). The daemon stays up; the OS reclaims the child's memory; the next request re-spawns a fresh engine. This is the §2 "a wedged sync loop holding the socket" reap that the singleton daemon-server explicitly does NOT do today (its own idle loop is wedged alongside).

**Scope when unblocked:** in the process-mode `ProjectHost`, arm a per-request deadline on each engine child; on overrun `child.kill('SIGKILL')` + return an honest `ToolFailure{tool:'timeout'}` to the agent (never a hang, never a guessed result); re-spawn lazily on the next request. Complements — does not replace — the in-process watchdog (t-095661): the watchdog covers `mcp --in-process` (no external killer) and is the same-process last resort inside `daemon serve`; kill-on-deadline is the precise per-child reap once isolation exists.

ARCHITECTURE §2 (spec-daemon-singleton "permanently wedged daemon … needs process-mode engine isolation + kill-on-deadline"), §9.
