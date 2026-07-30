---
id: t-899082
title: 'Test gap: the alias-collapse offset-drift guard (holdsName) is unpinned — a mutant dropping it passes every arm'
status: backlog
priority: low
type: infra
complexity: M
area: multi-program
source: dogfood-jul
relates:
  - t-000524
surface:
  - plugins/ts
audience: internal
evidence: measured
created: '2026-07-30T12:09:34.790Z'
---
`plugins/ts/ambiguity.ts` `holdsName` re-reads the identifier at the candidate's offset in each
consulted program before trusting that program's `getDefinitionAtPosition`. The offset is computed
against the OWNING program's SourceFile, and a planning overlay lives on the primary alone (§5-L2),
so inside a `transaction` a sibling reads DISK at a shifted offset — where the position denotes an
unrelated node and its "definition" an unrelated symbol. Without the guard two aliases could collapse
onto a declaration neither names: a confident answer about the wrong symbol.

The guard is in place; what is missing is a test that FAILS without it. Mutation-checked: deleting
`holdsName` from the loop passes all nine arms of
`test/differential/ambiguity-alias-collapse.test.ts`.

Why it was left unpinned rather than pinned cheaply: an observable difference needs the shifted
offset to land exactly on ANOTHER identifier that itself resolves — otherwise the retry returns
undefined and the guarded and unguarded paths agree. That is an engineered offset collision inside a
transaction whose second step addresses a bare name in a loose-root member, and the fixture is
delicate enough that it would pin the collision, not the guarantee.

Reachability IS real (not hypothetical): a `transaction` step takes a bare `{name}`, which resolves
through `resolveForWrite` → `resolveByName` → `distinctDeclarations` while the prior step's overlay
is active on the primary.

Worth doing when someone next touches the transaction fixtures. A `holdsName`-level unit test over a
hand-built pair of programs with divergent text would be the cheaper shape.
