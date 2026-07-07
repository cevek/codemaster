---
id: t-821130
title: 'Ambiguous-name resolution polish: collapse a pure re-export chain to its one underlying decl ("alias of …"), and rank the exported/production decl first'
status: backlog
priority: low
type: dx
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-07T20:06:53.245Z'
---
Inbox entries 5, 13, 45(part), 112, 117, 280, 2026-07-02→06. `find_usages`/`source`/`expand_type` on an ambiguous bare name error with the candidate list. Two polish asks on top of the already-shipped `find_usages {mergeDeclarations:true}` (which unions all same-named decls' usages — largely covers the "I want ALL refs across decls" case, entries 1, 32):

1. When the ambiguity is a **pure re-export chain of ONE underlying declaration** (`export { renderOperations } from …` + the real fn), resolve to it automatically or annotate "alias of `<decl>`" instead of listing two "independent" decls — they're the same symbol (entries 5, 45).
2. When one candidate is an **exported/interface decl in `src/`** and the rest are test-local `const`s, rank the production decl first / offer a `did you mean src/…:L:C?` so the common "audit the read-sites of this field" query needs no second call (entries 13, 117). Extend `mergeDeclarations` to `source`/`expand_type`/`construction_sites` for the multi-decl sweep case.
