---
id: t-216182
title: 'REGRESSION t-895142: orphaned `mcp --in-process` servers spin at 70-100% CPU in an uncaught-exception storm; neither watchdog branch reaps them'
status: backlog
priority: urgent
tags:
  - never-hang
  - watchdog
type: bug
complexity: M
evidence: measured
author: opus
created: '2026-08-30T16:59:58.783Z'
---
## Observed (live box, measured)

77 processes `node src/bin.ts mcp --in-process` alive with `PPID=1` (the spawning MCP host
gone), each burning 20-100% CPU; oldest ~1h05m elapsed / 21m CPU. Machine-wide CPU
starvation + thermal throttling. No codemaster op had run in those roots for days
(`~/.codemaster/usage/*.jsonl`), so the burn is NOT op work.

`sample <pid>` — main thread 100% inside:

    uv__run_check -> CheckImmediate -> InternalMakeCallback
      -> Isolate::ReportPendingMessages -> MessageHandler::ReportMessage
        -> node::errors::TriggerUncaughtException
          -> ErrorStackGetter -> FormatStackTrace -> PrepareStackTraceCallback
            -> CallSitePrototypeToString -> SerializeCallSiteInfo -> SourcePositionTableIterator

An endless uncaught-exception loop: something throws on every `setImmediate` tick, each
throw formats a full stack, and since the process runs TS through Node type-stripping the
source-position lookup is expensive. That serialization IS the burn.

`lsof`: fds 0/1/2 are `unix ... ->(none)` — the stdio socketpair peers are closed. The
`uncaughtException` handler in `bin.ts` `main` swallows the error and WRITES TO STDERR, so
it is a candidate for feeding its own loop.

## Two independent defects

1. **The storm.** `process.on('uncaughtException', ...)` keeps the process alive across an
   error that repeats every tick. A swallow-and-continue handler over a REPEATING fault is
   the §1 hang with a CPU price. Needs: identify the thrower on the dead-stdio path
   (suspect: a write to a closed stdio socket, or the MCP transport read loop after peer
   close), and give the handler a repeat-guard — N identical uncaught exceptions inside a
   window => one stall record, then exit. Never spin.

2. **Neither watchdog branch fired.** `~/.codemaster/stalls/` holds nothing newer than
   months-old records, so none of the 77 was reaped. Check in order:
   - `installWatchdog` reads `process.ppid` at install; if the host spawns the server
     already detached (ppid already 1), `watchParent` is false and orphan detection is
     SILENTLY off for the process lifetime — nothing records that.
   - the main-loop `startOrphanPoll` cannot run while the loop is saturated (by design —
     that is the worker's job), so the worker was the only defence and it also missed.
   - `processAlive(parentAtStart)` is pid-existence only: a recycled pid reads as "parent
     alive" forever on a busy box.
   - the WEDGE branch cannot fire either: the loop is not wedged, it is LOOPING, so the
     beacon keeps refreshing and `isWedged` stays false. **A busy-forever orphan is
     invisible to both branches** — that is the structural gap.

## Done when

- Repro (orphan an `mcp --in-process` server with dead stdio peers) exits instead of
  spinning, leaving a stall record that names the cause.
- An install that CANNOT watch a parent leaves evidence instead of silence.
- A busy-but-orphaned process is reaped: the wedge branch alone does not cover it.
