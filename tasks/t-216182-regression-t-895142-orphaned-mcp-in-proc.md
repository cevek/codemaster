---
id: t-216182
title: 'REGRESSION t-895142: orphaned `mcp --in-process` servers spin at 70-100% CPU in an uncaught-exception storm; neither watchdog branch reaps them'
status: done
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
## Diagnosis — CONFIRMED, two independent defects, both with deterministic repro

Observed on a live box: 77 processes `node src/bin.ts mcp --in-process`, `PPID=1`, each
burning 20-100% CPU, oldest ~1h05m elapsed. Machine-wide CPU starvation + thermal
throttling. `~/.codemaster/usage/*.jsonl` holds ZERO records from those roots, so the
processes never served an op — the burn is pure fault-loop.

### Defect 1 — the `uncaughtException` handler feeds its own loop

Caught live via CDP (`kill -USR1 <pid>`, `Debugger.setPauseOnExceptions`):

    Error: write EPIPE
      at Writable.write (node:internal/streams/writable:510:10)
      at process.<anonymous> (src/bin.ts:113:59)     <- the uncaughtException handler
      at process._fatalException (node:internal/process/execution:155:25)

`bin.ts` `main` installs

    process.on('uncaughtException', (err) => process.stderr.write(`codemaster: ${err.message}\n`));

When the MCP host is gone, stdio fds are dead sockets (`lsof`: 0/1/2 = `unix ... ->(none)`).
The first stdio write throws EPIPE -> uncaughtException -> the handler writes to stderr ->
that write throws EPIPE -> uncaughtException -> ... forever. Each iteration formats a full
stack, and because the process runs TS through Node type-stripping the source-position
lookup dominates (`sample`: 100% in `SerializeCallSiteInfo` /
`SourcePositionTableIterator`). That formatting IS the CPU burn.

The same shape exists in `daemon/engine-child.ts:66-67`.

REPRO (deterministic): keep the child's stdin peer OPEN (so no EOF -> the process will not
exit), close the stdout AND stderr peers after a completed MCP handshake, then send one
`tools/list`. The reply write hits EPIPE and the loop starts: ~85% CPU, forever.

### Defect 2 — orphan detection is silently disabled by a startup race

`installWatchdog` reads `process.ppid` at install and sets
`watchParent = orphanAware && parentAtStart > 1`. Node + TS type-stripping needs ~1s to
reach that line. If the spawning host exits inside that window the process is ALREADY
reparented, `process.ppid` reads 1, and orphan detection is turned off **for the whole
process lifetime, with no diagnostic anywhere**.

REPRO: spawn with `start_new_session=True` and let the spawner exit immediately -> the
process survives indefinitely (verified 40s+, 61% CPU, never reaped). Spawn with a spawner
that outlives the boot -> the worker reaps it in ~10s and writes a
`~/.codemaster/stalls/*.json` with `reason:"orphan"`.

Evidence at scale: `~/.codemaster/stalls/` holds 2 records for the day against 77 surviving
orphans — detection was armed for the rare slow-parent case only.

The WEDGE branch cannot cover this either: the loop is not wedged, it is LOOPING (the event
loop ticks), and the beacon is not even busy (no op is running), so `isWedged` stays false.
**A busy-forever orphan is invisible to both branches.**

### Why it avalanches

Each Claude session / subagent worktree spawns its own `mcp --in-process` server. Every one
whose host exits during the boot window leaks and pins a core. Enough leaks starve the box,
which slows the next boot, which widens the race window. The 77 accumulated across sessions
in `~/Dev/worktrees/claude-ui/*` and `~/Dev/claude-ui/.claude/worktrees/agent-*`.

## Fix

- [ ] The `uncaughtException` / `unhandledRejection` handlers must never throw: wrap the
      write in try/catch. That alone breaks the loop.
- [ ] EPIPE / ERR_STREAM_DESTROYED on our own stdio means the host is gone — exit, do not
      swallow-and-continue. Same for `daemon/engine-child.ts`.
- [ ] Add a repeat-guard: N uncaught exceptions inside a window => one stall record, then
      exit. A swallow-and-continue handler over a REPEATING fault is the §1 hang with a CPU
      price.
- [ ] Close the orphan-detect race: do not trust the ppid read at install. Either have the
      host pass its pid explicitly (env), or treat `ppid === 1` on the `orphanAware` path as
      "already orphaned" rather than "nothing to watch" — the current reading is the exact
      inversion of the truth.
- [ ] Make a disarmed watchdog leave evidence (stall-dir note / status line), never silence.
- [ ] The worker needs a branch for a busy-but-not-wedged orphan, since the existing two
      provably do not cover it.

## Done when

- The repro above exits instead of spinning, leaving a stall record naming the cause.
- A process whose spawner dies during boot is still reaped.
- An install that cannot watch a parent says so instead of going quiet.
