---
id: t-950675
title: Walk-mode syntactic surface pays one repo walk per surface build, uncoalesced — non-git freshness already debounces its own
status: backlog
priority: low
tags:
  - dogfood
type: perf
complexity: S
area: platform
surface:
  - plugins/ts
audience: internal
evidence: unverified
created: '2026-07-30T15:46:57.992Z'
---
On a non-git root the syntactic surface key IS the walk (`plugins/ts/syntactic-cache.ts`
`walkSurfaceKey`), so every surface build costs one bounded `walkFiles` — on top of the walk
`daemon/freshness.ts` already runs per op on the same root. That doubles the per-op tree walk in
exactly the workspaces that have no cheap git fingerprint. Cost is reasoned from the code, not
measured — hence `evidence: unverified`; measure before optimizing.

Neither walk is unbounded (no symlink is followed, depth/entries capped), so this is cost, not a
§1 hang: the expensive half (re-list + re-parse) still fires only on drift, and it is the same
ORDER of work already paid. But `freshness.ts` coalesces its walk behind `WALK_TTL_MS` (~1 s) and
this one does not, so a burst of ops in a non-git repo re-walks per call.

The fix wants a clock at the plugin boundary (the surface path is deliberately clock-free today —
`SurfaceSeams.now` exists only as a test seam), or a shared walk result the two paths both read.
The second is the better shape: one walk per op serving both freshness and the surface key would
be CHEAPER than today's git-repo behaviour is for its own two calls, not merely no worse.
