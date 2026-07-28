---
id: t-758704
title: 'FLAKY: watchdog-smoke backstop-1 (process-mode child) asserts the breadcrumb names the wedged ENGINE op, but under full-suite load it reads `freshness`'
status: backlog
priority: medium
tags:
  - platform
  - test-flake
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-27T22:49:27.245Z'
---
`test/e2e/watchdog-smoke.test.ts:104` ("backstop 1 (process-mode child)") asserts the stall
breadcrumb matches the wedged engine op. Under a full `npm test` run it failed with
`actual: 'freshness'` — the beacon publishes the OLDEST live op (`beacon.ts` `publish`), and under
CPU contention the freshness walk is registered first and outlives the assertion window, so the
published breadcrumb names `freshness` rather than the op under test.

Reproduction is load-dependent: the test passes in isolation (3/3) and also passes with 6 competing
CPU-burner processes, but failed inside a full-suite run. So it is a real ordering race in the
ASSERTION, not in the watchdog: the diagnostic value ("what was running") is arguably still honest —
`freshness` genuinely was the oldest live op — but the test claims a stronger guarantee than the
beacon gives.

Fix direction: either assert the breadcrumb names ANY live op of the wedged child and separately
assert the op-under-test is among the live set, or make the test's op provably the oldest (drive the
freshness walk to completion before the wedging call). Do not weaken it to a substring-anywhere
match, which would stop discriminating.

Unrelated to the crash-telemetry breadcrumb work (t-807677): that path is on the MCP facade
(`serveMcp`), which this test does not exercise.

## Reproduction data (4 full-suite runs, branch n3-antijoin-producers)

Duplicate t-523210 folded in here; this task carries the correct cause (the beacon publishes the
OLDEST live op, so `freshness` is honest by the beacon's own contract and the over-claim is in the
ASSERTION). The duplicate's competing explanation — "a later cheap span overwrites the breadcrumb, so
a real stall record would name the wrong op" — is WRONG and should not be built on: nothing
overwrites, the oldest-live-op rule is doing exactly what it says.

| run | commit | result |
| --- | --- | --- |
| 1 | 6d1c351 | green |
| 2 | dce82a7 | **fail** (`actual: 'freshness'`) |
| 3 | fb40cf5 | green |
| 4 | 6d8b4c0 | **fail** (same) |

Runs differ only by test-only commits; none touches `src/daemon/**`, `src/support/watchdog/**`, or
this test. Narrowing that sharpens the "load-dependent" note above:

- the file alone → 3/3 (twice);
- the whole `test:e2e` group under the machine lock → 345 tests, 0 fail;
- ONLY the full 1269-test suite reproduces it, ~50% of runs, and runs 3 and 4 were uncontended — so
  the trigger is parallelism WITHIN one full run, not another process competing for CPU.

That the e2e group alone stays green while the full suite flips is the useful new signal: the
competing span comes from test files outside e2e, so "6 competing CPU burners" (which passed) is not
the right model of the load — what matters is another engine's freshness walk registering first.

Since t-933867 landed, three condition-oracle test files run in that pool (one evaluating ~11k
site×input pairs), which raises the odds this surfaces — including in CI. It does not cause the race;
a test that catches an existing defect more often is working.
