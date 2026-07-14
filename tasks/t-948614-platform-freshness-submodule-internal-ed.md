---
id: t-948614
title: 'Platform freshness: submodule-internal edit not detected (daemon statDirty re-stats submodule dir, not its files) — §3.5 bound'
status: backlog
priority: medium
tags:
  - freshness
  - platform
created: '2026-07-14T14:27:21.408Z'
---
PLATFORM freshness bound (affects BOTH navto and the syntactic search — not feature-specific). `git status --porcelain` summarizes a dirty submodule as ONE path-level line (` M sub`), never enumerating `sub/a.ts`. So an edit to a file INSIDE an already-dirty submodule (after the first clean→dirty flip) is invisible to any freshness check keyed on the porcelain dirty set:
- `src/daemon/freshness.ts:~85` `statDirty` re-stats only `captured.data.dirtyPaths` (from plain porcelain) → for a submodule that's the DIR `sub`, whose mtime/size don't move on an internal edit → the host LS serves a stale parse → **navto stale**.
- `src/plugins/ts/syntactic-cache.ts::computeSurfaceKey` content-hashes the same porcelain dirty set → same dir-level entry → syntactic cache stale in the IDENTICAL case (consistent with navto, no new lie).

Fix direction (platform layer, daemon/freshness): when a dirty path is a submodule gitlink, recurse `git -C <sub> status --porcelain` (+ its HEAD) to enumerate/hash the submodule's own dirty files, rather than stat/hash the container dir. Bounded by submodule count × their dirty sets. Fixing it in daemon/freshness lifts BOTH navto and syntactic together (the right seam); fixing only the syntactic cache would make it inconsistently fresher than navto. Found via t-515730 dogfood bug-review (reproduced /tmp/smtest: same-key stale-serve after a second intra-submodule edit).
