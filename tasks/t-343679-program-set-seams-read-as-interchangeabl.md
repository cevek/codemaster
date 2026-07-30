---
id: t-343679
title: Program-set seams read as interchangeable but differ in cost by ORDERS OF MAGNITUDE — builtContaining's own FILTER builds every program, and the build-free membership predicate is not on the view it hands back
status: backlog
priority: high
parent: t-031282
type: dx
complexity: M
area: multi-program
source: dogfood-jul
relates:
  - t-000524
  - t-338692
  - t-533573
  - t-820448
surface:
  - plugins/ts/ls-host.ts
  - plugins/ts/program/single.ts
audience: internal
evidence: measured
created: '2026-07-30T12:18:12.166Z'
---
## Measured, and it nearly shipped

The host offers `programsContaining` / `builtContaining` / `sourceFileAcross` / `typeAuthorityFor`, and their
doc comments discriminate them along ONE axis: WHICH SET (read vs write, built vs file-driven, determinism).
Nothing says that `builtContaining` answers containment via `containsFile`, which is
`service.getProgram()?.getSourceFile(...)` — so merely **FILTERING** with it materialises the type-checker
Program of every program in the set:

    builtContaining → built().filter(p => p.containsFile(abs)) → service.getProgram()?.getSourceFile(abs)

Working t-000524 a worker picked `builtContaining` for a CORRECT reason (determinism / write-path
consistency) and shipped a change that, on a loose-root monorepo, would have built ~25 programs (~6.1 GB)
exactly where the t-167395 discovery prune keeps navto on the primary alone — and where an in-process OOM
kills the daemon. Two independent reviewers caught it; the code itself reads fine.

Worse, it defeats the §9 guard by construction: the pre-warm guard admits the op on the PRUNED peak, and the
un-pruned fan-out that follows is precisely what that same guard refuses. (Calibration from the parallel
measurement: a checker-backed op costs ~0.85 MB/file, so ~6.1k files ≈ 5.2 GB — the order is right.)

## Why the docs read as safe

`containsFile`'s own comment says "Is `absPosix` a source file in the BUILT program right now" — true, and it
reads as a cheap state query. The word "built" describes the SET, not the ACT. A caller learns the cost only
by following the call into `single.ts`.

The cheap predicate already exists — `SingleProgram.isTracked`, O(1) over the file list globbed at
construction — but it is NOT on the `TsProgram` view the fan-out seams hand back. So the expensive path is
the discoverable one and the cheap one is not.

## Fix

1. State the COST CLASS in each seam's doc ("`builtContaining` — forces a program build per candidate; use
   only when you are going to query those programs anyway").
2. Expose the build-free membership predicate on `TsProgram` beside it, so SELECTION and QUERYING are visibly
   different operations rather than one call that quietly does both.

## Class

Same as the `ls-host` `parseJsonConfigFileContent` incident recorded in CONTRIBUTING: correctness review
passes, small fixtures are instant, and the cost only appears at repo scale. A seam whose doc distinguishes
semantics but not cost is how a §1 violation gets written by a careful author.
