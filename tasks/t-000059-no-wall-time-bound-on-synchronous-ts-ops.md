---
id: t-000059
title: No wall-time bound on synchronous TS ops
status: in-progress
priority: medium
parent: t-031282
type: perf
complexity: L
area: platform
created: '2026-07-08T00:00:58.000Z'
---
**No wall-time bound on synchronous TS ops** — `find_unused_exports` (`cap×O(import-graph)`)
and a 10k-importer `find_usages` are bounded by DESIGN but don't degrade to honest
`ToolFailure{timeout}` on a pathological whole-repo call. The hard guarantee is §19 engine
isolation + kill-on-deadline (process mode — above). Meanwhile: scope with pathInclude.
`perf`·`med`·`cx:L`
