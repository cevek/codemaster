---
id: t-000148
title: expand_type` span→`at` agent-facing rename under-documented
status: backlog
priority: low
type: doc
complexity: S
area: render
relates:
  - t-000147
surface:
  - docs
  - ops
audience: external
evidence: repro
created: '2026-07-08T00:02:27.000Z'
---
**`expand_type` span→`at` agent-facing rename under-documented** — the data-shape changed
`span:{object}` → `at:"file:line:col"` (string); documented in the `span-validity` EXCLUSIONS comment but
not in the op's `notes`. Not a lie; add a 1-line op-note for the agent-facing rename. `doc`·`low`·`cx:S`
