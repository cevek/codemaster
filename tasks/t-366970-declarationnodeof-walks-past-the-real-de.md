---
id: t-366970
title: declarationNodeOf walks PAST the real declaration for a kind outside its list — find_definition/source print an enclosing function body under an inner name
status: backlog
priority: medium
type: bug
complexity: S
area: ts-core
source: dogfood-jul
surface:
  - src/plugins/ts/declaration.ts
audience: external
evidence: measured
created: '2026-07-30T11:57:54.469Z'
---
## Repro (current main, this repo, CLI one-shot)

    node src/bin.ts op source '{"file":"src/ops/source.ts","line":133,"col":14}'

`src/ops/source.ts:133` is `} catch (thrown) {`. The answer:

    ts:thrown@src/ops/source.ts:133:14 · local var @ :72:3
    async run(ctx, args): Promise<Result<JsonValue>> {
      … the whole `run` method body …

So the reported declaration of `thrown` is the enclosing `run` METHOD — ~60 lines of an unrelated
declaration, presented as this symbol's body, with a `@ :72:3` start position that silently disagrees
with the id's own `133:14`.

## Cause

`declarationNodeOf` (src/plugins/ts/declaration.ts) starts from an OFFSET and walks up until it meets a
node kind on its allow-list (function/class/interface/type/enum/method/property/module/VariableStatement).
A declaration kind NOT on that list — a catch-clause variable, a parameter, a `for` binding — is walked
straight past, and the walk stops at whatever enclosing declaration comes next.

## Why it matters

Both `find_definition` (at `verbosity:'full'`) and `source` build `SymbolView.decl` from it, so both
answer a body-shaped question with a body that belongs to a different symbol. The two fields the agent
would use to notice (`decl.line` vs the id's line) are far apart on screen and neither is flagged.

## Not a fix by the syntactic path

`source {syntactic:true}` (t-229522) is immune for a structural reason, not a shared one: it HAS the
declaration node (from `getNamedDeclarations`) and derives the span from it, so the offset-walk never
runs. The position-only walk stays the only consumer with the hole.

## Shape of a fix

The walk should stop at the NEAREST enclosing node that actually DECLARES the name at the offset (a
`getNameOfDeclaration(up) === nameNodeAtOffset` check), and where the nearest such node is not on the
allow-list, return that node rather than continuing upward. Returning `undefined` also beats the current
answer: the caller then falls back to the name span, which is honest.
