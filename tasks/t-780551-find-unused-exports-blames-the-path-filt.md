---
id: t-780551
title: find_unused_exports blames the path filter for an empty walk the PROGRAM emptied (inert lever)
status: backlog
priority: medium
type: bug
complexity: S
area: correctness
relates:
  - t-000011
  - t-259465
surface:
  - ops
  - plugins/ts
audience: both
evidence: repro
created: '2026-07-30T15:09:29.042Z'
---
`ops/find-unused-exports.ts` picks its `notAVerdict` wording off **whether a filter was set**, not off
**which cause emptied the walk**:

```ts
const filterSet = args.pathInclude !== undefined || args.pathExclude !== undefined;
const notAVerdict = view.scannedFiles === 0 ? notAVerdictWarning(filterSet) : undefined;
```

With a program that covers no source file (a degenerate `include`, a wrong root) AND any
`pathInclude`, `scannedFiles === 0` and `filterSet === true`, so the answer reads
"pathInclude/pathExclude matched 0 files — Check your path(s)/glob(s) against actual file paths"
while no glob could ever have matched. The lever named cannot change the outcome — the §3.6 /
t-259465 inert-lever defect, in the message written to prevent it.

Repro (CLI one-shot):

```
tsconfig.json  {"compilerOptions":{"strict":true},"include":[]}
src/lib.ts     export const dead = 1;

codemaster op find_unused_exports '{"pathInclude":["src/**"]}'
→ notAVerdict=… pathInclude/pathExclude matched 0 files … Check your path(s)/glob(s) …
```

The no-filter arm of the same call is correct (it names the tsconfig).

**Why the op cannot currently tell them apart:** `UnusedExportsView.scannedFiles` is counted AFTER
`scopePredicate`, so a post-filter zero is all the op sees. `ops/scan-coverage.ts` solves the identical
problem with `coverage.eligibleFiles` (the PRE-filter count) and branches on
`files === 0 && eligibleFiles > 0`; this view has no equivalent.

Fix: carry `projectFiles.length` (the in-scope file set before `inScope(rel)` is applied) on the view as
`eligibleFiles`, and pick the wording from `eligibleFiles > 0` — the filter emptied a non-empty program
— rather than from `filterSet`. The two-arm message and its key stay as they are.

Pre-existing in direction (the previous `filterSet &&` gate blamed the filter identically); what changed
is that the no-filter cause now has a correct message beside it, which makes the mis-attributed one the
only remaining wrong lever here.
