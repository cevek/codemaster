---
id: t-650055
title: find_usages / source FAIL tool=oom on a 6k-file monorepo even by exact SymbolId, and the redirect names ops that cannot answer the question
status: backlog
priority: medium
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
separate task (t-811950 — the child ceiling is derived from the box, so on a 16 GB+ machine these
three calls answer; the structural half below is what a smaller box, or a bigger repo, still needs).
What remains here is structural: the target
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

## MEASURED: scoping the fan is NOT the memory remedy on this repo shape

Measured on backoffice2 — the repo this was filed from: a bare name, a file-pin in `packages/common` and a
file-pin in `apps/emr` all cost 5.17–5.23 GB live heap and 27–31 s, because each answered from ONE
type-authority program. Discovery pruning already collapses the fan (26 programs constructed, Σ `fileNames`
18374, `estimateSearchPeak = {peakFiles: 6128, pruned: true}`), so the ~10 checkers never summed. The ~4.3 GB
delta over parse+bind (839–881 MB) is the checker / findReferences phase of that ONE program.

So "warm the containing program instead of all of them" cannot bring this repo under the 4 GB default, and the
memory argument above is withdrawn. Demoted high → medium.

What survives and needs restating before anyone works this: a pre-build path/config scope is still the honest
answer for repos where SEVERAL type-authority programs really are warmed for one question, and it is still the
inverse of `find_usages.programs` (which only ADDS configs). It is a precision / latency lever with a stated
floor, not the OOM fix. The claim-vocabulary trap (a program LOADED-but-not-SEARCHED is not the
config-NOT-LOADED claim) is unchanged and still gates it via t-885983.

Half 2 of this task — the redirect naming non-substitutes — is unaffected by the measurement and is being
closed by t-229522.
