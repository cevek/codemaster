---
id: t-650055
title: find_usages / source FAIL tool=oom on a 6k-file monorepo even by exact SymbolId, and the redirect names ops that cannot answer the question
status: backlog
priority: high
parent: t-338692
type: bug
complexity: L
area: multi-program
source: dogfood-jul
relates:
  - t-000075
  - t-000524
  - t-071368
  - t-544207
  - t-702879
  - t-885983
surface:
  - src/ops/guard/navigate.ts
  - src/plugins/ts/program/discover.ts
audience: external
evidence: reported
created: '2026-07-30T11:17:15.023Z'
---
## Reported (external agent, /Users/cody/Dev/backoffice2, repeated across multiple sessions)

Reviewing a PR, the agent needed the reference graph of three EMR mutation hooks.

Round 1 (by name, batch of 4): all four `FAIL tool=ts-ls — ambiguous` (the alias-as-declaration class).
Round 2, re-addressed with the exact SymbolIds the ambiguity error itself handed over:

    find_usages {symbolId:'ts:useUpsertFormV2@apps/emr/src/services/api/forms/emr.ts:135:14~088897ca', groupBy:'enclosing'}
    source {targets:[{symbolId:'ts:useMedicalEntriesV2@apps/emr/src/services/api/medicalEntries/medicalEntries.ts:50:14~088897ca'}, …]}

All four: `FAIL tool=oom`. Two distinct defects.

## 1. There is no cheap address

An exact SymbolId is the cheapest possible target, and `source` is "print this declaration" — yet both
OOM, because the cost is the WHOLE-PROGRAM WARM, not the query. The heap ceiling half of this is a
separate task (auto-escalated child gets the default ~4 GB). What remains here is structural: the target
lives in ONE program (`apps/emr`), and answering it warms every discovered program.

Asked for, and architecturally consistent with the floor vocabulary we already ship:
- a **path/config scope applied BEFORE the program is built** (the inverse of `find_usages.programs`,
  which only ADDS configs), with the unscanned programs NAMED in the floor;
- warm the CONTAINING program first and answer with a stated floor, rather than refusing.
  "A partial answer with a stated floor beats none" — the reporter's words, and the honesty vocabulary
  for it exists.

NOTE the scope-of-claim trap: the existing `UnsafeClaim` / undiscovered-program floor means "a config we
did not LOAD, so a same-named decl may hide there — index it". "A program we loaded and chose not to
SEARCH" is a DIFFERENT claim with a different remedy; folding both into one entry is the
two-authorities-on-one-question failure (§3.4 closed union). Decide the vocabulary before implementing.

## 2. The redirect names non-substitutes

`source`'s OOM failure printed: "What still answers here: symbols_overview {} → the repo's declared
symbol names per tsconfig — pick one, then search_symbol on it." `symbols_overview` returns NAMES and
`search_symbol` returns a declaration SITE; neither prints a body, and neither answers "who calls X".
`navigate.ts` has no `source` entry, so it falls to `orientation()`, which is honest about having no
substitute ("NO cheaper in-tool path") but still leads the eye to two calls that do not answer.
A syntactic `source` path (no program build — the surface already exists for
`symbols_overview` / `search_symbol {syntactic:true}`) would make that redirect real instead of nominal.
