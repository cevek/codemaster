---
id: t-193866
title: Ambiguity candidate lists carry no disambiguating signal (file:line:col + kind only) — add the resolved signature head per candidate, turning a 2-call guess into a 1-call pick
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T08:27:36.931Z'
---
`expand_type {name:'list'}` fails with "'list' is ambiguous (9 distinct declarations: …)" listing only
`file:line:col` + kind (property/const). In a repo where a generic verb name repeats across layers
(`src/api/read.ts`, `src/api/tree.ts`, `src/api/help.ts`, `src/validate/references.ts`…) the path alone is
often enough to GUESS but not to be SURE — so the agent spends a full extra call on the guess.

Ask: on the ambiguity FAIL, include a one-line `about=` per candidate — the resolved signature / type head,
which is the same string `expand_type` would return anyway. Same applies to `search_symbol` candidate
lists. Observed on /Users/cody/Dev/task-manager.

Sits directly on the ambiguity work of t-128204 (which made the candidate list complete, correctly counted
and decl-first) and t-811470 (which made each candidate a copy-pasteable canonical SymbolId). This is the
third leg: making the pick decidable without a round-trip.
