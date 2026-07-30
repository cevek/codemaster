---
id: t-479658
title: No op answers 'at which call sites is argument N a literal/constant' — a shared-gate refactor degenerates into reading every call site by hand
status: backlog
priority: low
parent: t-560034
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-000063
audience: external
evidence: reported
created: '2026-07-30T11:19:06.320Z'
---
## Reported (/Users/cody/Dev/task-manager, a shared-gate refactor: one `coerceValue` called from 4 sites)

The repeated question was not "who calls X" — `find_usages` answers that perfectly, and the
enclosing-function grouping made "which paths does this gate own" answerable in one call — but "at which
call site is argument K a literal that would now be REFUSED". Every call site had to be read by hand.

    call_arguments {name:'coerceValue', argIndex:1}

returning per-site the argument expression (literal / variable / expression) with its resolved type would
have replaced 4 file reads with one call. The `ts` plugin already has `callArgShapes` internally
(`t-000063` re-exports its result types), so the data is close to hand.

No other friction that session: `find_usages` on `coerceValue`/`parseKV`/`formatDetail` was exactly right
and surfaced a caller (`retypeFieldValue`) that a plain-name grep would have found but not contextualised.
