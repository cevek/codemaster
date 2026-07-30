---
id: t-585610
title: find_unused_exports enumerates candidates from the PRIMARY program only — a dead export declared in a sibling/package program is never a candidate, and the floor is undisclosed
status: backlog
priority: high
type: bug
complexity: M
area: correctness
relates:
  - t-000011
  - t-762573
surface:
  - plugins/ts
audience: both
evidence: repro
created: '2026-07-30T15:55:27.547Z'
---
`plugins/ts/unused-exports.ts` enumerates candidates from ONE program:

```ts
const program = host.service.getProgram();          // the PRIMARY
const projectFiles = program.getSourceFiles().filter(…);
```

Only the per-candidate USAGE check fans out (`classifyExport`: primary, then
`host.programsContaining(c.abs)`). So an export DECLARED only in a sibling / package program — a
`tsconfig.test.json` file, a workspace member, an isolated nested package (§5-L2) — never becomes a
candidate and can never be reported dead, however dead it is.

**Until this is closed, `unused (0)` from this op is NOT proof that a monorepo holds no dead
exports.** It is proof about the primary program's file set only. That is the same false-clean class
as t-000011 (an empty walk read as a clean repo), one door over: there the walk was empty and said so;
here the walk is FULL and complete-looking while whole programs were never enumerated.

Partially mitigated, not closed: the scope line
(`ops/unused-exports-scope.ts`, t-762573) now states the limit on every answer —
`enumeration is single-program — an export declared only in ANOTHER program is never a candidate here`
— and names the walked program with its denominators. That is a DISCLOSURE, not a fix: the answer is
honest about the gap, the gap remains.

Note the asymmetry that makes this cheap to miss: the undiscovered-program floor
(`undiscoveredProgramLabels`) demotes `certain`→`partial` for configs never LOADED, so a reader
reasonably infers that loaded programs are covered. They are covered for USAGE, not for ENUMERATION.

Fix shape (to design, not settled): enumerate across the loaded programs the way the type-anchored
scans fan (`plugins/ts/program/scan-fanout.ts` — a file CLAIMED by the first program in fan order, one
shared budget spent round-robin, deadline polled at the file boundary), keeping the cap and the
`truncated` honesty. The per-candidate usage fan already exists and needs no change. Whatever the
mechanism, the scope line's denominators must then become a union, and the "enumeration is
single-program" rule sentence must go with the same commit — a stale rule is worse than none.
