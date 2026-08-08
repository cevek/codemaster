---
id: t-220345
title: The response-cap remedy is generic prose that never names the capped op's own narrowing lever — "narrow the query" over a repo-wide condition op reads as an instruction with no argument to reach for
status: backlog
priority: high
parent: t-259465
tags:
  - agent-surface
  - dogfood
  - honesty
type: imp
complexity: S
area: render
source: dogfood-inbox-aug
relates:
  - t-549028
surface:
  - common/truncate
  - mcp
audience: external
evidence: repro
created: '2026-08-08T12:02:18.311Z'
---
The MCP-seam cap prints one fixed remedy for every op: *"Narrow the query, use verbosity:terse, or fetch one op via status {op:'…'}"* (`src/common/truncate/cap-response.ts`). For an op that reports a repo-wide CONDITION there is no "query" to narrow — the call took no target — so the line names a lever the reader cannot operate, the exact defect this epic exists to close. The reader is left believing no narrowing argument exists (and in the field concluded exactly that, on an op that HAS `pathInclude`).

The cap knows which op produced the response. It should say what that op's own scope lever is — `pathInclude`/`pathExclude` for the dead-code family, `limit`, `prefix` for the i18n ops — and where an op genuinely has none, say THAT outright rather than offering a generic narrowing the caller cannot perform (the `ops/guard/navigate.ts` doctrine: a refusal names a call the agent can actually make). `verbosity:terse` also must not be offered to a caller who already passed it.

Note the op-level cap hints already do this correctly in places (`find_unused_exports`: "narrow with pathInclude to cover the rest") — it is the SEAM-level marker, the one a large answer actually hits, that is generic.

## Свидетельство

2026-08-05, external field report, `amiro` worktree `forms-w3-ceiling`, cm=0.1.0: `find_unused_scss_classes {verbosity:'terse'}` → `unused (421) … !! OUTPUT CAPPED: data 41363 chars, showing first 19668`. Reporter: "when such an op caps, the cap currently reads as 'narrow the query', but for this family there IS no narrowing argument to reach for. Either the hint should say so, or the argument should exist." The argument does exist under a different spelling — see [[t-549028]] — which is why the generic remedy actively misled here rather than merely under-helping.
