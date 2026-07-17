---
id: t-140171
title: 'watchdog: fire a stall breadcrumb on the §19 cancellable-deadline path (partial-stall diagnostic)'
status: backlog
priority: low
parent: t-895142
tags:
  - platform
type: feat
complexity: S
area: platform
created: '2026-07-17T00:23:07.399Z'
---
**Fold-in split out of t-095661** (the two watchdog backstops shipped; this is the deferred third fold-in). t-095661's body asks: "fire the stall breadcrumb on the §19 cancellable-deadline path too (the more common partial-stall leaves a diagnostic)."

**Why deferred, not done:** the §19 `HostCancellationToken` deadline path (TS checker/search ops → `ToolFailure{tool:'timeout', partial}`) is NOT YET IMPLEMENTED — grep for `getCancellationToken`/`CancellationToken` in `src/` is empty. There is no deadline-firing site to wire a stall record into today except the `support/fs/walk.ts` wall-clock deadline, which already returns an honest `partial{timeout}` (a bounded, self-terminating path — low diagnostic value, and coupling `support/fs` → `support/watchdog` is a cross-support smell).

**When to do:** when the `HostCancellationToken` deadline path lands (its own roadmap item), have its overrun handler call `writeStallRecord(stallDir, {reason:'deadline', op:<breadcrumb>, …})` from `src/support/watchdog/stall-dir.ts` (already built + exported, `reason:'deadline'` variant already in the `StallRecord` union) so a partial stall leaves the same `~/.codemaster/stalls/<ts>.json` diagnostic a full wedge does — WITHOUT killing (a deadline is honest termination, not a wedge). The breadcrumb is already stamped by `beacon.measure` around `runOne`, so the op label is available.

Scope: tiny — one call site + a way to read the current beacon breadcrumb from the deadline handler. No new module.
