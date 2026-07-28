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
