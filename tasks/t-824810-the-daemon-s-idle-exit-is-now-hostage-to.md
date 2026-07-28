---
id: t-824810
title: The daemon's idle-exit is now hostage to every dispatch promise settling — one never-settling op makes the daemon immortal with a warm LS
status: backlog
priority: medium
tags:
  - platform
type: bug
complexity: S
area: platform
created: '2026-07-28T07:26:31.287Z'
---
`daemon/daemon-server.ts` `handle()` brackets each dispatch with `idle.enter()` / `idle.leave()` (the `finally`), so the idle deadline cannot fire while a request is in flight. That is deliberate and load-bearing: without it a client disconnecting mid-call releases the per-connection hold and the daemon can idle-exit under a live op — killing the call and leaving a breadcrumb behind a clean exit, which the next start promotes as a fabricated fatal.

The cost is a weakened tail invariant. `idle.leave()` runs only when `orchestrator.request(...)` SETTLES. Previously the hold was per-connection, so a stuck op could not prevent the TTL exit; now a single promise that never settles pins the daemon alive forever, holding its warm LS — §9 idle-eviction silently disabled, and the `support/watchdog/` backstop does not cover it (it reaps a wedged SYNCHRONOUS loop, not a pending promise).

In practice every known path settles: ops carry the 120 s cooperative `Deadline`, and `process-host.ts` settles all pending requests when an engine child dies. So this is "every path happens to settle", not a structural guarantee.

## Fix directions

- Bound the hold itself: release it after a ceiling (say the op deadline + a margin) even if the dispatch has not settled, accepting that a post-ceiling exit may leave a breadcrumb — and make that breadcrumb honest rather than suppressing it.
- Or track dispatch holds separately from connection holds and let the idle path force-exit past a hard ceiling, clearing live breadcrumbs the way `shutdown()` now does.

Whichever is chosen, the invariant to keep is the one the crash discriminator rests on: a CLEAN exit must leave no breadcrumb, so a promoted `origin:'daemon'` record always means a fatal.
