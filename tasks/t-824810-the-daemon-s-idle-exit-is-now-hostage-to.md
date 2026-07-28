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
relates:
  - t-000066
  - t-031282
  - t-384920
  - t-823472
  - t-826996
surface:
  - common
  - daemon
audience: internal
evidence: repro
created: '2026-07-28T07:26:31.287Z'
---
`daemon/daemon-server.ts` `handle()` brackets each dispatch with `idle.enter()` / `idle.leave()` (the `finally`), so the idle deadline cannot fire while a request is in flight. That is deliberate and load-bearing: without it a client disconnecting mid-call releases the per-connection hold and the daemon can idle-exit under a live op — killing the call and leaving a breadcrumb behind a clean exit, which the next start promotes as a fabricated fatal.

The cost is a weakened tail invariant. `idle.leave()` runs only when `orchestrator.request(...)` SETTLES. Previously the hold was per-connection, so a stuck op could not prevent the TTL exit; now a single promise that never settles pins the daemon alive forever, holding its warm LS — §9 idle-eviction silently disabled, and the `support/watchdog/` backstop does not cover it (it reaps a wedged SYNCHRONOUS loop, not a pending promise).

In practice every known path settles: ops carry the 120 s cooperative `Deadline`, and `process-host.ts` settles all pending requests when an engine child dies. So this is "every path happens to settle", not a structural guarantee.

## Fix directions

- Bound the hold itself: release it after a ceiling (say the op deadline + a margin) even if the dispatch has not settled, accepting that a post-ceiling exit may leave a breadcrumb — and make that breadcrumb honest rather than suppressing it.
- Or track dispatch holds separately from connection holds and let the idle path force-exit past a hard ceiling, clearing live breadcrumbs the way `shutdown()` now does.

Whichever is chosen, the invariant to keep is the one the crash discriminator rests on: a CLEAN exit must leave no breadcrumb, so a promoted `origin:'daemon'` record always means a fatal.

## What still backstops this — read before assuming §1 never-hang regressed

The headline reads worse than the reality. Three layers still cover the realistic cases, and the trade bought the removal of a REAL bug (the daemon exiting in the middle of another client's live call):

- **A cooperatively-cancellable op settles on its own.** Every op carries the wall-clock `Deadline` (`daemon.opDeadlineSeconds`, default 120 s): the LS polls it inside `findReferences`/navto and multi-call ops poll it at loop boundaries, so the dispatch promise settles with a `timeout` / `partial` and the hold is released. The idle path is untouched.
- **In `process` mode the parent reaps regardless.** `process-host.ts` bounds every request; on overrun it SIGKILLs the child, and `markDead` settles EVERY pending request. So an engine that cannot be cancelled cooperatively still settles the daemon-side promise.
- **A true synchronous wedge was never covered by idle-exit anyway.** Timers do not run on a blocked event loop, so `createIdleExit` could not have fired before this change either. That case has always belonged to the EXTERNAL path — the kill-target-hint pidfile and `daemon stop|restart`'s SIGTERM→SIGKILL escalation (§2/§19).

**The genuinely new hole** is narrower than the title: an ASYNC promise that never settles on a still-responsive loop, in `in-process` mode, where no kill-on-deadline exists. No current path produces one (the two above cover the known shapes), which is exactly why this is filed as "every path happens to settle" rather than a structural guarantee — a future op that awaits something un-deadlined would land here, and nothing would catch it.

So: not a §1 regression to be panicked about, but a guarantee that is now upheld by the callers rather than by construction. That is the thing worth restoring, and the reason the fix directions above all end at the same invariant — a CLEAN exit must leave no breadcrumb.
