---
id: t-000162
title: typecheck.preExisting` count is non-deterministic across identical runs
status: backlog
priority: medium
type: bug
complexity: M
area: correctness
created: '2026-07-08T00:02:41.000Z'
---
**`typecheck.preExisting` count is non-deterministic across identical runs** — two back-to-back
identical `codemod` dry-runs reported `preExisting=3` then `preExisting=2`. A flapping baseline
error count means the gate's "introduced vs pre-existing" split can misclassify on the boundary
(a real introduced error could be absorbed as pre-existing, or vice versa) — a correctness risk,
not cosmetic. Investigate the baseline typecheck determinism (program reuse / diagnostic order).
`bug`·`med`·`cx:M`
