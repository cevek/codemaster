---
id: t-341133
title: scan-coverage's empty-scan remedy tells a pathExclude author their glob 'matched 0' — the exclude matched EVERY file, so the named lever is counter-productive
status: backlog
priority: medium
type: bug
complexity: S
area: correctness
relates:
  - t-780551
surface:
  - ops/scan-coverage.ts
audience: external
evidence: repro
created: '2026-07-30T16:16:27.049Z'
---
`ops/scan-coverage.ts` `emptyScanRemedy` (the `construction_sites` / `discrimination_sites` fan):

```
Your pathInclude/pathExclude matched 0 of the ${eligibleFiles} file(s) the program(s) scanned (…)
hold — the path filter, not the program set, emptied the scan.
```

The wording is INCLUDE-semantics. When a `pathExclude` alone empties the walk, the glob matched EVERY
eligible file — that is precisely why nothing is left. Told "your glob matched 0", the author's
correct-looking next move is to WIDEN the exclude, which keeps the scan empty forever: a lever that
moves the outcome the wrong way, in the module whose job is to name levers that work (§3.6 / t-259465).
The trailing "drop the filter to scan all N" limits the damage, which is why this is medium, not high.

The fix is a phrase: state what the filter LEFT, not what it MATCHED — `the path filter left 0 of the
${eligibleFiles} file(s) … in scope` — which is true of both filter kinds and needs no branch.

Filed rather than fixed inside t-780551/t-762573 because `scan-coverage.ts` is the shared home of two
OTHER ops: changing their rendered output needs their own tests re-verified, and that track's remit was
`find_unused_exports`. The same defect was fixed there (`ops/unused-exports-scope.ts`), so the two homes
now word one situation differently until this closes — check them together.
