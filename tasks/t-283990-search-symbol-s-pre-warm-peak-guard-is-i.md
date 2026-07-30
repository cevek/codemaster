---
id: t-283990
title: search_symbol's pre-warm peak guard is isolation-blind — its 9000-file threshold is calibrated against the DAEMON's ~4 GB default heap, so it refuses inside an escalated child whose ceiling is now box-derived
status: backlog
priority: medium
type: bug
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-338692
  - t-396905
  - t-735577
surface:
  - src/ops/search-symbol.ts
  - src/plugins/ts/plugin.ts
audience: external
evidence: measured
created: '2026-07-30T11:57:06.704Z'
---
## The gap

`search_symbol`'s pre-warm PEAK guard (`src/ops/search-symbol.ts`, the `estimateSearchPeak()` branch)
reads no isolation signal — unlike the semantic fan-out guard, which fires only while the engine is
`in-process` (`ctx.daemon.isolation`). Its threshold `DEFAULT_SEARCH_WARM_PEAK_MAX_FILES = 9000` is
documented in `src/plugins/ts/plugin.ts` as calibrated so that "a pruned peak ~1.4 GB or a fan-out peak
~3.0 GB" stays "under a ~4 GB default heap".

That premise now holds only for the DAEMON's own process. A `process`-mode child's ceiling is derived
from the box (`src/daemon/heap-ceiling.ts`: config verbatim, else half the RAM within [4096, 8192] MB),
so an escalated workspace on a 16 GB+ machine has ~2× the heap the threshold assumes and is still
refused by the same number.

## Measured context (32 GB box, node v22.21.1, `/Users/cody/Dev/backoffice2`, 6126 git source files)

- `estimateSearchPeak` = `{peakFiles: 6128, pruned: true}` → under 9000, so THIS repo is not refused.
  **A non-repro here is not absence**: the guard's threshold is repo-size-dependent, so the defect
  lives one notch larger (a pruned peak, or a `references` fan-out that does not prune, anywhere in
  9000..~18000 files — backoffice2's own un-pruned Σ is 18374). Reproducing it needs a bigger repo,
  not a different call; concluding "not reproduced, therefore not real" would be reading the wrong
  variable.
- The rate the threshold rests on is right for navto-class work and wrong for checker-backed work:
  parse+bind of the primary program costs ~0.14 MB/file (measured 839–881 MB over 6128 files),
  a checker-backed `find_usages` over the SAME program ~0.85 MB/file (5.17–5.23 GB).

## What a fix has to decide

Whether the peak threshold is one number or two: a warm inside a killable child with a known ceiling
is a different risk from a warm in the shared daemon (where an OOM is uncatchable and takes every
workspace down). Deriving the refusal from the CHILD's actual ceiling — rather than a constant pinned
to Node's default — is the honest form; the guard must keep refusing in-process at the current
calibration.
