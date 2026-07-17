---
id: t-783490
title: Auto whole-daemon-kill recovery (bridge-side) — needs bridge-reconnect or explicit next-session scope
status: backlog
priority: low
parent: t-031282
depends_on:
  - t-000051
  - t-000052
tags:
  - platform
type: feat
complexity: L
area: platform
created: '2026-07-17T00:04:05.108Z'
---
Split out of t-000051 (wedged-daemon recovery) as its B2 phase — deferred because it is unsafe without a prerequisite.

## What
Automatic bridge-side recovery of a wedged FRONT-DOOR daemon: after N reply-timeouts on an open connection (gated to `process` isolation, where a `daemon-info` ping cleanly discriminates a true front-door wedge from a merely-busy in-process loop), escalate to force-kill the daemon via the t-000051 `force-recover` helper (pidfile → SIGTERM(grace)→SIGKILL → respawn through `connectOrSpawnDaemon`).

## Why deferred (the blocker)
Killing the whole daemon STRANDS every live bridge: `remote-orchestrator.onClose` sets `closed=true`, all future requests fail "daemon connection closed" forever, there is NO reconnect, and `bin.ts` connects once. So an AUTO recovery that bricks live MCP sessions is worse than the wedge for those sessions. The in-session zero-collateral path is t-000051 B1 (kill the wedged CHILD engine via t-000052 process-mode; daemon + bridges survive) — that is the primary recovery and lands in t-000051.

## Prerequisite (pick one, decide at pickup)
- **bridge-reconnect**: `RemoteOrchestrator` transparently re-establishes the socket on `onClose` (retry a bounded number of times) so a daemon respawn is invisible to a live session. Non-trivial (in-flight request replay semantics, at-most-once vs at-least-once).
- **OR explicit next-session scope**: B2 respawns for the NEXT MCP session only; the current session is honestly told to restart (RECONNECT_NOTE), same as the manual `daemon restart` verb. Cheaper, but only helps future sessions.

Manual force-kill (`daemon stop`/`restart`) already lands in t-000051 A2 — this task is only the AUTO trigger. Depends on t-000052 (process-mode discrimination) + t-000051 (the force-recover helper + B1 child-kill).
