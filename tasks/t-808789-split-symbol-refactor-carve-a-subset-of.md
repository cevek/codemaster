---
id: t-808789
title: '`split_symbol` refactor: carve a subset of statements / a function body into a new top-level function in another module and repoint (the last mile of file-splitting sweeps)'
status: backlog
priority: low
type: feat
complexity: L
area: ts-refactor
source: dogfood-jul
created: '2026-07-07T20:07:03.365Z'
---
Inbox entry 4 (`code-diff`), 2026-07-02. During an output-identical module split, `move_symbol` cleanly relocated whole functions, but one function (`updatesAndMoves`) had to be split into two separate exported functions in different files (`classifyContent`→pair-ops.ts, `classifyPositional`→positional-ops.ts). `move_symbol`/`extract_symbol` can't do that — `extract_symbol` pulls a sub-expression into a new local, not "carve a subset of statements / loop body into a new top-level function in another module and repoint the orchestrator." Fell back to manual Edit. A `split_symbol` (or `extract_symbol` with a target module + function signature) would close the last mile of file-splitting sweeps — common when a file crosses the size cap and a monolithic function must fan out. Ergonomics, not a bug.
