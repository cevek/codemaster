---
id: t-000079
title: Sibling-program robustness on the READ path — a malformed sibling tsconfig sinks the op
status: backlog
priority: low
type: bug
complexity: S
area: multi-program
created: '2026-07-08T00:01:18.000Z'
---
**Sibling-program robustness on the READ path — a malformed sibling tsconfig sinks the op** —
the per-program READ fan-outs (`getNavigateToItems`/`resolveModuleArg`/`findReferences`) aren't
individually guarded, so a throwing sibling bubbles to the op-level catch and takes the PRIMARY
answer with it. Degrade per-sibling (skip + surface the bad program), as the §2.8 WRITE gate
now does (`gateAcross`/`diagnosticsAcross` degrade a throwing SIBLING to a note, never the
primary). Not a false-report; low frequency. `bug`·`low`·`cx:S`
