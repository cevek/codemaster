---
id: t-826996
title: 'watchdog: extend breadcrumb coverage to the spawn/routing path (config-load, getOrSpawn, daemon routing loop)'
status: backlog
priority: low
parent: t-895142
tags:
  - platform
type: feat
complexity: S
area: platform
created: '2026-07-17T00:32:19.050Z'
---
**Coverage-gap follow-up from t-095661** (both reviewers flagged; safe direction — a MISSED wedge, never a false-positive kill, so not a merge blocker).

The wedge watchdog stamps a `beacon.measure` breadcrumb at three engine sites: `runOne` (op), `refresh()` (freshness walk — the incident's own wedge site), and `createEngine` per-plugin `init` (LS lazy-warm rides inside `op:` measure). Heavy synchronous work on the main thread OUTSIDE these sites runs with the beacon reading idle, so a wedge there is NOT reaped by backstop 1:

- `daemon/orchestrator.ts` `getOrSpawn` → `tsProjectRefusal` / config-load that runs BEFORE `createEngine` (a pathological tsconfig-reparse / walk — the exact `ls-host` incident class §19 names).
- The daemon's own routing loop in `daemon-server.ts` (`handle`) — a wedge in routing itself, not in an engine op.

**Fix direction:** wrap the spawn-path heavy work (config-load + engine construction in `getOrSpawn`) and, for the daemon, the routing-`handle` body in `beacon.measure` breadcrumbs so the beacon is non-idle during that work → the worker reaps a wedge there too. Keep it a passthrough when inactive (the existing seam). Bounds still apply — no per-call repo-scale work introduced.

This closes the backstop's coverage over the incident's OWN family end-to-end. Manager also earmarked "watchdog as a guard in the daemon's own routing-loop" as a future item — this is it.
