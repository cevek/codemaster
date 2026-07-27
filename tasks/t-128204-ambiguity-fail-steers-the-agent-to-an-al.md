---
id: t-128204
title: 'Ambiguity FAIL steers the agent to an ALIAS: all listed candidate sites are `(alias)` and the real declaration is absent or last, so "pass file:line:col" picks a re-export'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-27T23:00:17.386Z'
---
Found while measuring op cost on /Users/cody/Dev/backoffice2 (worker dd428a19).

`find_usages {name:"SaveButton"}` / `{name:"SubmitButton"}` fail as ambiguous with 8 and 7 candidate
declarations. Every listed site is tagged `(alias)` — the barrel/re-export chain — while the REAL
declaration is either missing from the list or sits last. The accompanying hint says "pass file:line:col
or a SymbolId", so an agent following it verbatim pins an ALIAS, not the declaration it meant.

Two distinct problems:

1. **Ranking** — a real declaration must outrank an alias in the candidate list. Today the ordering
   makes the wrong pick the default one.
2. **Completeness** — if the real declaration can be ABSENT from the enumerated candidates while
   aliases are listed, the ambiguity report is itself incomplete (§3.4): the agent cannot choose a
   target that is not shown.

Second-order effect worth noting: this is what made the original OOM incident confusing. The repro
`find_usages {symbols:[SaveButton, SubmitButton]}` short-circuits on ambiguity in ~13 s and never reaches
the reference fan-out at all — so the call that LOOKED like the OOM trigger was not the one that warmed
the checker. Diagnosing the crash required pinning a file first.

Related: t-811470 (ambiguity list prints file:line:col but not the canonical SymbolId to copy).
