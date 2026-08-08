---
id: t-712642
title: member_usages does not classify the ACCESS SHAPE of an array member — `content[0]` / `.find(…)` (a decision by position) is indistinguishable from `.map(…)`, so a whole defect class cannot be swept
status: backlog
priority: high
parent: t-151992
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-127800
  - t-675220
audience: external
evidence: reported
created: '2026-08-08T12:06:19.982Z'
---
## What is missing

For an array-typed member, the SHAPE of the access carries the meaning that the member's name does not — the
same way discrimination_sites exists because the shape of a check carries meaning. Reading a list by
position (`resp.content?.[0]`, `all.find(s => …)`) makes the result depend on an order nobody ordered;
iterating it (`map` / `filter` / `for-of`) does not. Today both come back as the same site.

Wanted: a classification on `member_usages` (or a separate op) of the access form —
`index-literal` / `index-dynamic` / `find` / `findIndex` / `at` / `iterate` / `length`. "Who decides by
position" is then one call with a filter, and pure iteration is filtered out automatically.

Must reach through a local binding: `const all = resp.content ?? []; all.find(…)`. Without that hop, the
class is caught by halves, and the uncaught half READS as clean — which is the honesty problem, not just a
recall one.

Why the alternatives do not cover it: `member_usages {member:'content'}` gives the read sites without the
form; `find_usages` on the type is wider and equally form-blind; `codemod` (ast-grep) can express
`$X.content[0]` but is no longer a semantic query — it does not know that `$X` is the response of a
particular endpoint and misses aliases and intermediate variables.

## Свидетельство

2026-08-05, `amiro/qa2-booking-half-save`. A list arrives from the server in an order set by the server's
default pagination, and the frontend picks "the right" record BY POSITION —
`sales.content?.[0]`, `allSales.find(s => s.status !== 'DELETED')`. In that repo this decides which sale a
payment is applied to (tracked there as `t-5d6pz5`). Finding every instance requires "who indexes or `find`s
over an array that came from a response of type T" (`PagedModelSaleV2Dto.content`), and no op answers it.
