---
id: t-599414
title: the syntactic scope test treats a function-scoped 'var' in two blocks as two symbols
status: backlog
priority: low
type: bug
complexity: S
area: ts-core
source: dogfood-jul
surface:
  - src/plugins/ts/syntactic-decl-index.ts
audience: external
evidence: repro
created: '2026-07-30T13:23:07.057Z'
---
## Repro

    function fn() { { var v = 1; void v; } { var v = 2; void v; } }

`source {name:'v', file, syntactic:true}` returns a pick-list of two candidates. There is ONE symbol: `var`
binds to the enclosing FUNCTION, not to the block, so both declarations declare the same `v`.

## Why it is only a `low`

The output is a REFUSAL with a pick-list, and the message no longer asserts the candidates are different
symbols — it states the boundary it observed and says outright that it cannot tell separate symbols from one
symbol declared in several places. So the answer is conservative and honest, not a lie; an agent pays one
extra call.

## Cause

`isScopeContainer` includes `Block`, which is right for `let`/`const` and wrong for `var`. A fix would
consult the declaration's own declaration-kind: for a `var` declarator, climb to the nearest FUNCTION-like
(or the SourceFile) rather than stopping at the block.

Pre-dates the scope-collapse work — `Block` was in the container list from the start.
