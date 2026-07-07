---
id: t-000010
title: find_unused_exports` vacuous-filter warning fires only on a FULLY vacuous filter
status: backlog
priority: low
type: dx
complexity: S
area: bug-sweep
created: '2026-07-08T00:00:09.000Z'
---
**`find_unused_exports` vacuous-filter warning fires only on a FULLY vacuous filter** —
`src/ops/find-unused-exports.ts` raises `filterMatchedNoFiles` when `scannedFiles===0`, so a
filter where SOME paths are typos but others match (`scannedFiles>0`) scans a partial scope
with no warning. Safe direction (no false-positive), but a partly-mistyped `pathInclude`
still under-scans silently. Consider a per-pattern match count → warn on any pattern that hit
0 files, named. `dx`·`low`·`cx:S`
