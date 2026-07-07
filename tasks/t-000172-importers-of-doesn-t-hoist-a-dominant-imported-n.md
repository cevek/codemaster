---
id: t-000172
title: importers_of` doesn't hoist a dominant imported name
status: backlog
priority: low
type: dx
complexity: S
area: correctness
created: '2026-07-08T00:02:51.000Z'
---
**`importers_of` doesn't hoist a dominant imported name** — each row trails `· <imports>`, which
for a SINGLE-export module is a constant (= the main export) repeated on every importer. A
`hoistUniform`-style lift would densify it. NOT done: dogfood shows `imports` is a VARYING set
per file for multi-export/barrel modules (`partial,ok` / `ok` / `fail,messageOfThrown,ok` …), so
no dominant constant exists there — a hoist is fragile and rarely applies. Revisit only with a
"single dominant covers ≥X% of rows" guard. `dx`·`low`·`cx:S`
