---
id: t-000112
title: Reverse import-capture does a full-AST walk over the program
status: backlog
priority: low
type: perf
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:51.000Z'
---
**Reverse import-capture does a full-AST walk over the program** — O(nodes), bounded (module
resolution memoized per (dir, spec), second pre-move resolution gated to specifiers landing on a
new arrival), same cost class as the §2.8 typecheck; but no per-op wall-clock deadline (shared
§19 gap). Optional bound: pre-filter files with no module specifier before the child-walk.
`perf`·`low`·`cx:M`
