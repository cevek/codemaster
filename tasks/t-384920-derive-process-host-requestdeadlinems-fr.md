---
id: t-384920
title: Derive process-host requestDeadlineMs from daemon.opDeadlineSeconds (+margin) so raising the in-op budget pushes the hard-kill out too
status: backlog
priority: low
parent: t-031282
depends_on:
  - t-000059
tags:
  - deadline
  - platform
type: imp
complexity: S
area: platform
created: '2026-07-17T01:05:54.641Z'
---
Reconcile between t-000052 (process-mode isolation) and t-000059 (sync-op wall-clock deadline), deferred because the two landed separately (the config field didn't exist when the keystone merged).

## Now (shipped)
- t-000059: in-op cooperative deadline `daemon.opDeadlineSeconds` default **120s** → HostCancellationToken → `ToolFailure{timeout}` / `partial`.
- t-000052: process-host hard-kill `BRIDGE_REPLY_DEADLINE_MS` hardcoded **150s** (strictly > in-op 120s, so graceful-partial always fires before the SIGKILL). This is a DECOUPLED constant — it does NOT read the config field.

## The improvement
Wire the hard-kill to DERIVE from the config in `bin.ts::buildOrchestrator`:
`requestDeadlineMs = (config.daemon.opDeadlineSeconds ?? 120) * 1000 + MARGIN_MS` (e.g. +30_000), so a user who RAISES `opDeadlineSeconds` (a legitimately slow large repo) also pushes the process hard-kill out — preserving the `in-op < process-kill` invariant at any budget, not just the default. `requestDeadlineMs` doubles as the bridge reply deadline (one constant), so the bridge wait tracks it automatically. Keep the 150s literal as the fallback when no config.

Both prerequisites are now in main (t-000052 + t-000059). One-line-ish change in bin.ts + a test that a raised opDeadlineSeconds widens the derived hard-kill.
