---
id: t-290877
title: Nothing states how MANY independent floors are active in one answer — each disclosure says 'this number is a floor', none says it is a floor four times over
status: backlog
priority: medium
parent: t-786727
type: imp
complexity: M
area: correctness
source: dogfood-jul
relates:
  - t-100043
  - t-647309
  - t-828100
audience: both
evidence: measured
created: '2026-07-30T11:17:56.566Z'
---
## The class

About a third of the impact-usages/ts-core/multi-program slice is a defect each body correctly
self-classifies as "safe direction / honest under-report, never a false-certain" — and each is therefore
`low`. Locally right. In aggregate ONE answer can be simultaneously:

- floored by an undiscovered program,
- cut by the name-candidate view cap,
- severed at a `Result<JsonValue>` seam (`t-100043`),
- blunted by a repo-global demote,

and nothing states the composition. Each disclosure says "this number is a floor"; none says "it is a
floor four times over". That composition is the honest number a reader needs, and no task owns it — which
is why every individual one stays `low` and the aggregate never gets priced.

## Ask

Count the ACTIVE independent incompleteness sources for an answer and state the count (with their causes)
as one envelope fact. Cheap to render, and it is the only line that tells a reader whether the number in
front of them is worth acting on.
