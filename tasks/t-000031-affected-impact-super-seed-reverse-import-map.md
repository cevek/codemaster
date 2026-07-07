---
id: t-000031
title: "affected/impact super-seed: reverse-import map"
status: backlog
priority: medium
type: perf
importance: medium
complexity: M
area: phase-5
created: '2026-07-08T00:00:30.000Z'
---
**affected/impact super-seed: reverse-import map** — the `affected` super-seed fans `importersOf`
(un-memoized O(files) scan) per changed file; in sparse mode (import-leaf changes) the node-budget
break never fires → O(traced×files), slow-but-terminating (the op note states this honestly).
Build a reverse-import map once (one O(F) scan) + memoize `importersOf`. Same class as **impact:
wall-clock deadline**. `perf`·`med`·`cx:M`
