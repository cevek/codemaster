---
id: t-000011
title: find_unused_exports` false-clean on a broken program (no filter)
status: backlog
priority: low
type: bug
complexity: S
area: impact-usages
created: '2026-07-08T00:00:10.000Z'
---
**`find_unused_exports` false-clean on a broken program (no filter)** — when the LS program is
`undefined` (`src/plugins/ts/unused-exports.ts:87`) and NO pathInclude/pathExclude is set, the op
returns `unused(0)` / `scanned 0 files` with NO warning — the vacuous-filter guard gates on
`filterSet`, so a broken/empty program reads as "nothing dead" (a §3.4 false-clean in the
no-filter path the filter guard doesn't cover). Rare (needs a program-load failure), surfaced in
T2 review. Fix: warn on `scannedFiles===0` regardless of filter, or on `program===undefined`.
`bug`·`low`·`cx:S`
