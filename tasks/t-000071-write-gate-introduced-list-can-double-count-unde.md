---
id: t-000071
title: Write-gate `introduced` list can double-count under OVERLAPPING globs
status: backlog
priority: low
type: bug
complexity: S
area: multi-program
created: '2026-07-08T00:01:10.000Z'
---
**Write-gate `introduced` list can double-count under OVERLAPPING globs** — a genuinely-new
move/extract DEST owned by TWO overlapping programs, carrying an error, is diagnosed once per
program in the overlay while the baseline has zero → the same `file:line:message` appears twice
in `introduced` (`introducedDiagnostics` multiset-diffs but does not dedup the `after` set). The
verdict (`clean:false`) and refusal are CORRECT; only the displayed count is inflated. Bites only
overlapping-glob + erroring new dest. Fix: dedup-on-display. `bug`·`low`·`cx:S`
