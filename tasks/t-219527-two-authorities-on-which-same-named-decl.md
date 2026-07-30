---
id: t-219527
title: two authorities on 'which same-named declarations are one symbol' — the checker resolve path and the syntactic one
status: backlog
priority: medium
type: imp
complexity: M
area: ts-core
source: dogfood-jul
surface:
  - src/plugins/ts/syntactic-decl-index.ts
audience: internal
evidence: repro
created: '2026-07-30T12:38:01.524Z'
---
## The seam

Two modules now answer "given N declarations sharing a name, which are one symbol and which are rivals":

- the checker path — `ambiguity.ts` `distinctDeclarations`, which collapses by RESOLVED DEFINITION (it has
  a checker, so a barrel chain folds into one symbol);
- the syntactic path — `syntactic-decl-index.ts` `collapseByScope`, which collapses by SCOPE IDENTITY (no
  checker available; TS rejects a non-mergeable duplicate within one scope, so same-scope ⇒ one symbol).

Both are correct for their own oracle and they are NOT interchangeable. But they answer one question, so
the next change to either — a new mergeable shape, a different top-level preference — lands in one and not
the other, and the two paths then disagree about whether a name is ambiguous.

## What to unify, concretely

Not the SourceFile provider (host programs vs the no-program surface differ by design — that difference IS
the feature) and not the five-way addressing dispatch (8 lines, and each mirrors the other deliberately).
What belongs in one place is the collapse POLICY as a pure predicate over declaration nodes, with the
checker-only definition-collapse layered on top of it where a checker exists.

Blocked on nothing; wants doing while both implementations are fresh.
