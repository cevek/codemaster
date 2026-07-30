---
id: t-307027
title: the syntactic declaration index cannot list overload SIGNATURES (no binder collapses the set)
status: backlog
priority: low
type: imp
complexity: M
area: ts-core
source: dogfood-jul
surface:
  - src/plugins/ts/syntactic-decl-index.ts
audience: external
evidence: measured
created: '2026-07-30T12:38:01.131Z'
---
## The limit

`source {syntactic:true}` prints an overloaded function's IMPLEMENTATION and lists no signatures, while the
checker path reports all declarations of the set.

Cause: without a binder `node.symbol` is `undefined` on every `ts.createSourceFile` node, so TS's own
same-symbol dedup inside `computeNamedDeclarations` collapses an overload set to ONE node — the
implementation, which replaces its body-less predecessors. There is nothing for the index to list.

Printing the implementation is the BETTER body to show, so the answer itself is right. The limit is stated
in the op's always-on note, so it is disclosed rather than silent.

## Fix, if it is worth it

Recover the siblings syntactically: same name, same parent statement list, `!body` → list them as
`moreDefinitions`. Cheap for a function overload set; an `interface`+`namespace` merge already works
(different node kinds are not collapsed).
