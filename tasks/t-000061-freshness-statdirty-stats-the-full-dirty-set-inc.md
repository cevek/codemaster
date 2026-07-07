---
id: t-000061
title: "freshness `statDirty` stats the FULL dirty set incl. `--untracked-files=all"
status: backlog
priority: low
type: perf
importance: low
complexity: S
area: platform
created: '2026-07-08T00:01:00.000Z'
---
**freshness `statDirty` stats the FULL dirty set incl. `--untracked-files=all`** — the
re-dirty content check (`src/daemon/freshness.ts`) re-stats every porcelain-dirty path on
every op-entry check; `dirtyPaths` includes untracked files, so a repo with a large
un-gitignored untracked tree pays per-op stat work that scales with it (not a hang — stat is
cheap, untracked files keep old mtimes → no hash escalation). Scope `statDirty` to
tracked-modified paths (untracked can't be the porcelain-insensitive re-dirty case). `perf`·`low`·`cx:S`
