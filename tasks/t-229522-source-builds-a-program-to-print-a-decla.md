---
id: t-229522
title: source builds a program to print a declaration body — a no-program syntactic path would make 'show me the code' work at any repo size
status: done
priority: high
parent: t-338692
type: feat
complexity: M
area: ts-core
source: dogfood-jul
relates:
  - t-503986
  - t-650055
  - t-810757
surface:
  - src/ops/source.ts
  - src/plugins/ts/syntactic-surface.ts
audience: external
evidence: measured
created: '2026-07-30T11:17:15.423Z'
---
## The gap

"Print the body of this declaration" is a SYNTACTIC question, and codemaster already owns a no-program
syntactic surface (`syntactic-surface.ts` + the `@internal` `getNamedDeclarations`, ARCHITECTURE §5-L2)
that `symbols_overview` and `search_symbol {syntactic:true}` answer from with no LS warm. `source` does
not use it: it resolves through the checker, so it warms the program and dies with everything else on an
oversized repo (measured: `source {targets:[…symbolId…]}` → `FAIL tool=oom` on a 6101-file monorepo,
child heap ceiling ~4144 MB).

## Why this one first

It is the cheapest real capability win in the OOM class: it needs no memory model, no fan-out redesign,
and no new honesty vocabulary — the syntactic path's disclosure already exists.

## Requirements

- `provenance:'syntactic'` and the SAME disclosure `search_symbol {syntactic:true}` carries: a syntactic
  hit cannot prove WHICH same-named declaration was printed, and the scan covers git-tracked source
  under the root only (an outside-root tsconfig include is not covered).
- The checker path stays the default where it is affordable; the syntactic one is the honest degrade
  (either opt-in `syntactic:true` for symmetry with `search_symbol`, or an automatic fallback that says
  so on the envelope — decide at the plan gate, do not ship both).
- Once it exists, `ops/guard/navigate.ts` gains a real `source` entry, replacing today's
  no-substitute arm.

## MEASURED CORRECTION: the OOM premise does not hold — the value is latency, heap, and batch survival

Measured on backoffice2 (box 32 GB, node v22.21.1, default limit 4144 MB): `source` with a file-pin costs
839 MB / 4.5 s, and by BARE name with 27 same-named declarations (`AppLayout`) 881 MB / 5.8 s — BOTH pass on
the default 4 GB heap. The field report's `source` OOM was a BATCH passenger death: all four calls travelled
in one batch beside three `find_usages`, and the neighbour (≈5.2 GB live heap) burned the process.

So this task does NOT stand on "otherwise unanswerable". What it stands on, in strength order:

1. **Batch survival — the live unusability.** A checker-backed `source` inside a batch with any fan-out op
   dies with it; a no-program path answers.
2. **An order of magnitude.** 839 MB / 4.5 s against 5.2 GB / ~30 s for "print this body".
3. **`navigate.ts` stops naming non-substitutes** — today `source`'s refusal falls to the orientation arm and
   points at `symbols_overview` / `search_symbol`, neither of which prints a body.

Priority stays high on (1). The scope of the work is unchanged; only the claim it may make is.

### Settled at the plan gate (do not re-litigate)

- **opt-in `syntactic:true`, not an auto-degrade.** `source {file,line,col}` means "resolve this POSITION to its
  definition" — verified live: a position on the `ok(` CALL returns the body from `common/result/construct.ts`.
  A syntactic path cannot do that, so defaulting would be a silent capability regression. And an auto-degrade
  cannot fire on a REAL OOM at all: the child dies, `run()` never returns, there is nothing to catch — that
  would be a new pre-warm guard on `source`, i.e. guard-coverage work, not this task.
- **The scope statement rides the data `note` (the channel `search_symbol {syntactic:true}` already uses), not
  an envelope `Disclosure`.** Per §3.6 a disclosure is born where a target was RANKED and one was picked
  silently; this resolve does not rank (single declaration, else a pick-list), so attaching one would be false
  partiality. The note must also say the path is DIFFERENT, not strictly worse: its reach is the git source
  surface, so a file in no tsconfig is visible to it and invisible to the checker path.
