---
id: t-523210
title: 'flaky under CPU load: watchdog-smoke "backstop 1 (process-mode child)" reads a `freshness` breadcrumb instead of the wedged engine op'
status: backlog
priority: medium
tags:
  - flaky
  - tests
type: bug
complexity: S
area: platform
created: '2026-07-28T07:52:19.236Z'
---
`test/e2e/watchdog-smoke.test.ts:104` ("backstop 1 (process-mode child): a wedge in the forked
engine-child is reaped through the ENGINE op wrap") failed once during a full `npm test` that ran
concurrently with another agent's test runs:

```
error:  'the breadcrumb names the engine op that wedged'
actual: 'freshness'      (expected: the wedged op's name)
```

Passes in isolation (`node --test test/e2e/watchdog-smoke.test.ts` → 3/3) and passed in a full run
minutes earlier on the parent commit, so it is timing-sensitive, not a regression: under contention
the beacon breadcrumb the watchdog reads is the `freshness` walk's rather than the wedged op's.

That is a real ordering question in the breadcrumb itself, not only a test-scheduling artifact
(§13: the breadcrumb is the honest diagnostic for a wedge — if a later cheap span can overwrite the
span that actually wedged, a real stall record can name the wrong op). Worth deciding deliberately:
either the breadcrumb should not be overwritten by a span that STARTED after the wedge began, or the
test must pin the ordering it depends on instead of racing it.

Reproduce by running the file under load (e.g. alongside another full suite).

## Reproduction data (4 full-suite runs on this branch)

| run | commit | result |
| --- | --- | --- |
| 1 | 6d1c351 | green |
| 2 | dce82a7 | **fail** (`actual: 'freshness'`) |
| 3 | fb40cf5 | green |
| 4 | 6d8b4c0 | **fail** (same assertion, same `actual`) |

Runs 2 and 4 differ from 1 and 3 by test-only commits, and none of the four commits touches
`src/daemon/**`, `src/support/watchdog/**`, or the test itself — so this is not a regression from any
of them. Narrowing:

- the file alone: `node --test test/e2e/watchdog-smoke.test.ts` → 3/3, twice.
- the whole e2e group under the machine lock: `npm run test:e2e` → 345 tests, 0 fail.
- only the FULL suite (1269 tests, files running in parallel) reproduces it, ~50% of the time.

So the trigger is parallel load inside one full run, not another agent's process (runs 3 and 4 were
both uncontended). Worth stating plainly: the branch adds three condition-oracle test files, one of
which evaluates ~11k site×input pairs, so it raises the parallel CPU load that tips this race — it
does not cause the race, but it makes an existing one more likely to surface, including in CI.

The failure mode remains the one that matters (§13): the watchdog reads the beacon breadcrumb and
gets `freshness` — a cheap span that started AFTER the wedge — instead of the op that actually
wedged. A real stall record would name the wrong op, which is a diagnostic confidently pointing the
wrong way. Fix candidates: do not let a later span overwrite a breadcrumb whose owner has not
completed, or have the test pin the ordering instead of racing it.
