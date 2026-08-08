---
id: t-444796
title: search_symbol ranks an unrelated prefix match beside the exact name with no exactness marker, and getting from "which symbol" to "what it does" always costs a second call
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: ts-core
source: dogfood-inbox-aug
surface:
  - ops
audience: external
evidence: repro
created: '2026-08-08T12:29:56.475Z'
---
Two small frictions on the shortest useful path there is — "does this exported symbol do X" — observed answering a one-line behavioural question (`does api.search apply the archived-exclusion default`).

## 1. No exactness marker on a short common name

`search_symbol {query:'search', pathInclude:['src/api/**']}` returns the exact `search`, an alias re-export of it, and an unrelated `searched` — ranked together, with nothing in terse output distinguishing the exact match from the prefix one. The caller has to read each identifier to find the one they named.

navto ranks by matchKind internally, so the information exists at the point of production and is dropped at render. On a short, common name — precisely where the fuzzy search returns rivals — the exact hit should be marked as such.

## 2. Symbol → behaviour is always a second round trip

The only way from "which symbol" to "what it does" is `source`. `expand_type` gives the signature, which does not answer a delegation: here the body was `list(ctx, text)` — two tokens, and the whole answer.

For a one-expression arrow or a pure delegation, inlining the body at `search_symbol`'s normal verbosity would close this class in one call. That is deliberately NOT a general "always include bodies": the value is specific to a body small enough that its text costs less than the round trip, which is exactly the case where the signature alone is least informative.

## Свидетельство

2026-08-08, `/Users/cody/Dev/task-manager`. Path taken: `search_symbol` (3 hits, one unrelated) → `source {symbolId}` → body `list(ctx, text)`. Both steps worked and were fast; the note is about the shape of the path, not a failure.
