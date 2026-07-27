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
