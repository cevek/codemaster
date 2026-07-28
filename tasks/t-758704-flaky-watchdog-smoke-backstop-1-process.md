---
id: t-758704
title: "FLAKY: watchdog-smoke backstop-1 (process-mode child) — the arm's 200ms wedge threshold has no headroom over the pre-wedge freshness span, which spawns git"
status: done
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
`test/e2e/watchdog-smoke.test.ts` arm "backstop 1 (process-mode child)" compresses the watchdog's
5-minute production wedge threshold to 200 ms. That threshold applies to EVERY measured span, and
this arm goes through the real request path, whose per-read `freshness` walk is measured
(`engine.ts` `refresh`) and **spawns `git`** (`checkGit` runs before the mtime-walk fallback). When
process-spawn latency pushes that legitimate span past 200 ms, the worker reaps the child while it
is merely SLOW — the stall record then reads `op: 'freshness'`, `seq: 1`.

`seq: 1` is the decisive fact: the beacon published exactly ONE breadcrumb, so `op:wedge` never
started. There is no live-set overlap and no competing span — the beacon's oldest-live-op contract
is not implicated at any point.

## Causal repro (deterministic, no full-suite coin flips)

A `git` shim that sleeps 0.5 s in front of `PATH`, against the arm's own spawn shape at the 200 ms
threshold, reproduces the reported symptom byte-for-byte, 3/3:

```
op="freshness" seq=1 reason=wedge elapsedMs≈235   (threshold 200, poll 50)
```

Without the shim the same probe is 3/3 `op:"op:wedge"` `seq=2`. Load models that do NOT reproduce
it: 24-way CPU oversubscription on 12 cores (4/4 green) and a 24k-file root (2/2 green) — CPU burn
and repo size are the wrong variables; process-spawn latency inside the pre-wedge span is the one.

## Fix

Threshold raised 200 → 3000 ms for this arm only, with the reason recorded at the call site. The
wedge is an infinite spin, so headroom costs only wall-clock (arm runs ~3.4 s, outer timeout 20 s).
The assertion is unchanged (`/op:wedge/`) and the failure message now prints the whole record, so a
future recurrence names its own cause. Arm 1 needs no change — it stamps its own breadcrumb with
nothing else measured, so 200 ms is structurally safe there; arm 2 already sets 600000.

Measured margin after the fix: a 2 s `git` spawn passes (10× the previously-fatal 0.5 s); past the
3 s threshold the run is inconclusive and fails naming `freshness`/`seq 1` — the honest residual of
compressing a 5-minute threshold into a test.

Discrimination verified by mutation: removing the `beacon.measure` op wrap (`engine.ts`) → red via
the outer timeout; forcing `isWedged` to `false` → red on the SIGKILL assert. Both probes reverted.

Not a product defect: at the 5-minute default no legitimate span approaches the threshold, so the
`reason: 'wedge'` inference stays sound (§1). Unrelated to the crash-telemetry breadcrumb work
(t-807677), which lives on the MCP facade.
