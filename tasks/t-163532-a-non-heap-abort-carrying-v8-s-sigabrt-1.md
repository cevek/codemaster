---
id: t-163532
title: A non-heap abort carrying V8's SIGABRT/134 signature is reported as "cannot complete on this repo" — the OOM verdict rests on a hint the relayed fatal dump could confirm
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
  - platform
type: bug
complexity: M
area: correctness
source: dogfood-jul
created: '2026-07-28T17:39:38.184Z'
---
`daemon/process-host.ts` `isOom` classifies a dead engine child as an OOM from the exit signature
alone (`code === 134 || signal === 'SIGABRT'`), and documents itself as a HINT: "the signature is
not portable, so we only HINT `oom` when it matches — never assert it on an ambiguous exit (that
would be its own small lie)."

Two agent-facing claims are then built on that hint, and both are assertions rather than hints:

- the verdict clause — `${name} cannot complete on this repo`, reserved for OOM precisely because
  "the heap was exhausted, and a retry does the same thing again";
- `ToolFailure.outOfReach: 'any-program-build'` — every call that builds a TS program is out of
  reach here, which drops every program-building redirect.

A `process`-mode child can abort with 134/SIGABRT for reasons that are not heap exhaustion: a
native abort from `better-sqlite3` during a `sql`-carrying batch (loaded lazily inside the engine),
a V8 `FATAL ERROR: Check failed`, `--abort-on-uncaught-exception`. The next request respawns a
fresh child (§19) and the retry would in fact have worked — so the agent is told the repo cannot
answer a question it can answer, and is steered off the calls that would have answered it.

The evidence to settle it is already captured and already on disk: the child's stderr is relayed
line-by-line into `child-stderr.log` (§13), and a V8 heap OOM prints `FATAL ERROR: ... JavaScript
heap out of memory` there. Confirming the signature against that line before making either claim
turns a hint into proof; failing to find it should degrade to `outOfReach:
'unproven-program-build'` and the weaker `did not complete` verdict, which are exactly the shapes
that already exist for a deadline kill.

Scope note: the relay writes asynchronously and a dying child's last bytes are still in the pipe
when `exit` fires (that is why the sink is released on the stream's end, not on `exit`), so this
needs a bounded wait or a "confirm if already seen, else unproven" rule — never a hang (§1).

Found while closing t-615758, which introduced the `outOfReach` claim; the verdict clause it
matches is older.
