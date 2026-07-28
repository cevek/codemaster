---
id: t-523210
title: 'flaky under CPU load: watchdog-smoke "backstop 1 (process-mode child)" reads a `freshness` breadcrumb instead of the wedged engine op'
status: done
priority: medium
tags:
  - flaky
  - tests
type: bug
complexity: S
area: platform
created: '2026-07-28T07:52:19.236Z'
---
**Duplicate of t-758704** — same test (`test/e2e/watchdog-smoke.test.ts:104`, "backstop 1
(process-mode child)"), same assertion, same `actual: 'freshness'`. All content, including this
task's 4-run reproduction table, now lives there; work the flake from t-758704.

Kept as a closed pointer rather than deleted because commit messages on branch
`n3-antijoin-producers` reference this id.

**Correcting the cause this task originally claimed**, so it is not carried forward: it said a later
cheap span OVERWRITES the breadcrumb, and therefore a real stall record would name the wrong op.
That is wrong. The beacon publishes the OLDEST live op (`support/watchdog/beacon.ts` `publish`), so
when the freshness walk registers first the breadcrumb names `freshness` by the beacon's own
contract — nothing is overwritten and the diagnostic is honest. The defect is that the TEST asserts a
stronger guarantee than the beacon gives. t-758704 had this right from the start.
