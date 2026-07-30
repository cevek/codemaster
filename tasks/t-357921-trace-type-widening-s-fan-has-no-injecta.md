---
id: t-357921
title: trace_type_widening's fan has no injectable seam for its skip/deadline arms — three real runtime states proven only by reading
status: backlog
priority: low
type: imp
complexity: M
area: multi-program
source: dogfood-jul
relates:
  - t-467009
surface:
  - plugins/ts/type-widening.ts
audience: internal
evidence: measured
created: '2026-07-30T15:32:21.658Z'
---
`collectWideningSinks` records three skip reasons and a mid-walk deadline hit, each with its own
note and each demoting the trace:

- `deadline` — the budget was spent before the fan reached a program (and, when it empties the fan
  entirely, the step FAILS rather than answering 0);
- `program-unavailable` — no Program / no source file for a program that contains the file;
- `no-value-here` — the position resolves to no value under that program's own options.

All three are reachable at runtime; none is reachable from a VFS fixture. A deadline needs a seam to
inject an already-expired `Deadline` into `wideningSinksAt` (the op builds it from
`daemon.opDeadlineSeconds`), and the other two need a program that contains a file but fails to
build or to resolve a symbol in it — neither constructible from `project({...files})`.

Consequence, and why this is worth closing rather than tolerating: the `≥` floor rendering
(`truncated.totalIsLowerBound` in the cap note, `floorMark` in the budget note) fires ONLY when a cap
and a skip coincide, so it too is unexercised. That is the marker that stops a floor being read as an
exact count (§12) — the one thing in this op's output that can silently overstate.

The same seam would serve the sibling scans (`runFanoutScan` polls a deadline at the program and file
boundary with the same untested arms), so build it once at the plugin API rather than per op.
