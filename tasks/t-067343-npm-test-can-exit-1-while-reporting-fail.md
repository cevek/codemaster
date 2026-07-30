---
id: t-067343
title: npm test can exit 1 while reporting 'fail 0' with no 'not ok' and empty stderr — the exit code disagrees with the TAP verdict
status: backlog
priority: medium
type: bug
complexity: M
area: correctness
source: dogfood-jul
surface:
  - package.json
audience: internal
evidence: measured
created: '2026-07-30T12:50:21.821Z'
---
## Observed

Four consecutive full `npm test` runs on one unchanged tree: ONE exited 1, three exited 0. The failing run's
output was indistinguishable from a passing one —

    # tests 1409
    # suites 6
    # pass 1408
    # fail 0
    # cancelled 0
    # skipped 1

no `not ok` line anywhere, and nothing on stderr (the run captured `2>&1`, so a message would have been in
the file; the last bytes are the summary itself).

The failing run was concurrent with four CPU-saturating subagent processes; the three clean runs were not.
So the trigger is most likely load/timing, not the tree.

## Why it matters more than a flake

The exit code is what CI gates on and what an agent reads to decide "green". A run whose code disagrees with
its own verdict is a false-RED here, and the same mechanism inverted is a false-GREEN — a test file whose
process dies after its assertions pass, with `node --test` still counting them, would be reported as passing.
§16 makes determinism an architecture requirement precisely so a verdict means one thing.

## Where to look

`node --test` exits nonzero when a test FILE's process exits nonzero even with every subtest passing (an
unhandled rejection or a `process.exit` during teardown, a worker killed under memory pressure). Candidates
are the suites that spawn real processes — `test/e2e/` daemon/bridge lifecycle, the process-mode fork tests,
the watchdog ones. A first step that costs nothing: have the test script surface the per-file exit codes
(`--test-reporter=spec` keeps them, or run the groups separately) so the next occurrence names its file
instead of vanishing into an identical summary.
