---
id: t-229522
title: source builds a program to print a declaration body — a no-program syntactic path would make 'show me the code' work at any repo size
status: backlog
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
