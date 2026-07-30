---
id: t-762573
title: 'find_unused_exports emits a bare scanned: exports/files counter that names no program — the same numerator-without-denominator that cost a false-diagnosis round-trip'
status: backlog
priority: medium
type: imp
complexity: S
area: render
source: dogfood-jul
relates:
  - t-467009
  - t-919920
surface:
  - ops/find-unused-exports.ts
audience: external
evidence: measured
created: '2026-07-30T15:21:32.817Z'
---
`find_unused_exports` fans across programs (primary first, then the candidates dead-in-primary), but
its scope block is `scanned: exports=N files=M` — a numerator with no denominator and no naming of
what was searched.

Repro on current main:

    node src/bin.ts op find_unused_exports '{"pathInclude":["src/common/iter/**"]}'
    unused (0):
    scanned:
      exports=1 files=1
    undiscoveredPrograms (3): …

`files=1` is indistinguishable from "the repo has 1 file" and from "1 of 900 because we searched one
program". The `undiscoveredPrograms` block beside it is a DIFFERENT floor (a config never loaded)
and supplies no denominator for what WAS searched.

## The fix shape (proven twice)

State the scope positively, per unit of scope, with the denominator in the line — as
`construction_sites` / `discrimination_sites` do (`ops/scan-coverage.ts`, file-denominated) and
`trace_type_widening` does (`ops/trace-type-widening-scope.ts`, reference-denominated). Pick the unit
this op actually enumerates in before reusing either module: reusing a vocabulary whose completeness
discriminator is denominated in the wrong unit is how a complete answer gets printed as
`!! NOT A VERDICT` (the reason the widening track did not reuse `scan-coverage.ts`).

## Also swept, UNVERIFIED

`find_unused_i18n_keys` (`scanned: {keys, usages}`), `find_unused_scss_classes`
(`scanned.modules/classes`), `css_cascade` (`scanned: {sheets}`) — same bare shape, not reproduced
hermetically. Each has its own partial-disclosure machinery (css_cascade names its failed sheets and
caps confidence to partial), so the residual may be smaller or absent.
