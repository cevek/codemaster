---
id: t-858687
title: discrimination_sites lists the sites that discriminate a union but does not report that two INDEPENDENT predicates classify it differently — the divergence between them is the question, and it is answered by hand
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-304222
  - t-312854
audience: external
evidence: reported
created: '2026-08-08T12:06:38.617Z'
---
## What is missing

`discrimination_sites` enumerates the sites that discriminate a union type T (shipped under t-304222). What
it does not report is the relationship BETWEEN two independent classifiers over the same union: when one
module partitions T by table A and another by predicate B, the interesting fact is where the two partitions
DISAGREE — that divergence is a live bug the moment it appears, and nothing surfaces it.

Wanted: group the discriminating sites by the predicate/partition they apply over T, and report constituents
classified differently by two groups (or covered by one and not the other).

## Свидетельство

2026-07-30, `task-manager/api-reflist-verbs`. Adding element-level write verbs. Over the union
`FieldType: 'list' | 'reflist' | …` the repo carries two independent predicates: `edgefields.ts` classifies
by `EDGE_ARITY`, while `apply.ts` / `collection-ops.ts` classify by `spec.type ∈ {list, reflist}`. Whether
those two agree was precisely the question being resolved, and it was resolved by hand.

The rest of the track had no friction: `find_usages` on `applyOps` immediately gave the full consumer list
(3 enclosers) with proof spans, which is what set the edit's scope.

Note for the reader: this report ALSO contained a discoverability complaint — that `discrimination_sites`
being the op for "where is this union discriminated" is not readable from its name or catalogue line, so the
reporter did not connect the two. That half belongs to the op-discoverability cluster and is not restated
here.
