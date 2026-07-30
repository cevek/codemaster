---
id: t-821130
title: 'Ambiguous-name resolution polish: collapse a pure re-export chain to its one underlying decl ("alias of …"), and rank the exported/production decl first'
status: backlog
priority: low
type: dx
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-000524
  - t-161435
  - t-791164
  - t-944489
surface:
  - plugins/ts
audience: both
evidence: reported
created: '2026-07-07T20:06:53.245Z'
---
Inbox entries 5, 13, 45(part), 112, 117, 280, 2026-07-02→06. `find_usages`/`source`/`expand_type` on an ambiguous bare name error with the candidate list. Two polish asks on top of the already-shipped `find_usages {mergeDeclarations:true}` (which unions all same-named decls' usages — largely covers the "I want ALL refs across decls" case, entries 1, 32):

1. When the ambiguity is a **pure re-export chain of ONE underlying declaration** (`export { renderOperations } from …` + the real fn), resolve to it automatically or annotate "alias of `<decl>`" instead of listing two "independent" decls — they're the same symbol (entries 5, 45).
2. When one candidate is an **exported/interface decl in `src/`** and the rest are test-local `const`s, rank the production decl first / offer a `did you mean src/…:L:C?` so the common "audit the read-sites of this field" query needs no second call (entries 13, 117). Extend `mergeDeclarations` to `source`/`expand_type`/`construction_sites` for the multi-decl sweep case.


## Residual after t-000524 (the proven collapse), and why it stayed a guess

t-000524 makes point 1 above PROVEN for the reachable case: an alias whose module spec the answering
program cannot resolve is re-asked across the other built programs, so a re-export chain in a
loose-root monorepo collapses to its one underlying declaration by the project's OWN module
resolution. Two asks from the field remain, and both are guesses rather than proofs — which is why
they were deliberately left here instead of shipping with that fix:

- when the exact-name matches contain exactly ONE non-alias declaration, resolve to it instead of
  failing (`preferDeclarations`, or as the default);
- if the aliases must stay visible, report them as `aliases: N` on the envelope rather than as
  candidates to disambiguate between.

They now apply ONLY to the residual: an alias no program can resolve (t-000524's NEG-2 arm — a
genuinely broken/external spec), or one two configs resolve DIFFERENTLY (its NEG-3 arm). In exactly
that residual the alias may name a declaration we never saw, so resolving to the sole visible one
would answer about a different symbol than the agent asked for — silently. Where the resolution IS
recoverable a proof is available and is already taken; a heuristic there would only replace it.

So if this is picked up: scope it to the residual, and make the `aliases: N` envelope report part of
it rather than a separate polish — an answer that quietly drops unresolvable aliases from the
candidate list must say how many it dropped (§3.4).
