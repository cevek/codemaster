---
id: t-140171
title: 'watchdog: fire a stall breadcrumb on the §19 cancellable-deadline path (partial-stall diagnostic)'
status: backlog
priority: low
parent: t-031282
tags:
  - platform
type: feat
complexity: S
area: platform
relates:
  - t-826996
surface:
  - daemon
  - support
audience: internal
evidence: repro
created: '2026-07-17T00:23:07.399Z'
---
Split out of t-095661, whose two watchdog backstops shipped; this is the third fold-in it names:
"fire the stall breadcrumb on the §19 cancellable-deadline path too (the more common partial-stall
leaves a diagnostic)."

## Present state — both ends exist, the join does not

The §19 cooperative deadline is wired: `src/plugins/ts/cancellation.ts` holds the shared
`HostCancellationToken` predicate the programs poll (`ls-host.ts`, `program/single.ts`); on overrun
it raises `DeadlineExceededError`, which the op turns into `ToolFailure{tool:'timeout'}`. Multi-call
ops poll `deadline.expired()` at loop boundaries and return `partial` instead.

The sink is built: `support/watchdog/stall-dir.ts` exports `writeStallRecord`, and `StallRecord.reason`
already carries the `'deadline'` variant beside `'wedge'` / `'orphan'`.

Missing is only the connection between them. No deadline-overrun site writes a stall record, so a
partial stall leaves nothing in `~/.codemaster/stalls/`, while a full wedge leaves the breadcrumb that
says WHAT was running.

## The one design point

`support/watchdog/beacon.ts` exposes `measure()` and publishes the oldest live crumb into the
SharedArrayBuffer — it has **no read accessor**. The wedge reaper reads that buffer from its worker
thread; a same-thread deadline handler cannot. So this needs either a small `beacon.current()` or the
crumb threaded down to the overrun site. `beacon.measure` already stamps the op label around `runOne`,
so the label itself is available either way.

## Scope

One call site plus that accessor. No new module, and no kill — a deadline is honest termination, not a
wedge, so the record is a diagnostic only.

Deliberately NOT wired to `support/fs/walk.ts`'s own wall-clock deadline: it is a bounded,
self-terminating path with low diagnostic value, and `support/fs` → `support/watchdog` is a
cross-support edge.
