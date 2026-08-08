---
id: t-731041
title: 'A type whose values provably come from outside the index reads like any other local type: generated-API DTOs are not marked boundary-typed, and the op-map''s "questions about a symbol" framing reads as total over questions the tool cannot reach'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-034354
  - t-089408
surface:
  - docs
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:01:15.543Z'
---
In a frontend whose contract oracle is a sibling backend repo, a large class of questions is shaped like a
symbol question and is not answerable by the index: what the server PUTS in a DTO field, which projection
serializes it, which writes reach it. codemaster answers what the code DOES with the value; the authority for
what the value IS lives in another language, another repo.

Two gaps, both cheap relative to the class:

1. **No boundary marker.** A type under `src/api/generated/**` (openapi-generated DTO / response type) has a
   PRODUCER outside the index by construction. Nothing in an answer about it says so. An op that flagged
   "this is a boundary type — its producer is outside the indexed project" would send the agent to the
   backend deliberately instead of by luck, and would make the honest half of the answer legible: usages are
   complete, provenance is not. `construction_sites` on such a type is structurally near-empty for the same
   reason — the real constructions are in the other language — and answers as if it had looked.

2. **The op-map claims more remit than it has.** "questions about a symbol's identity / type / reference
   graph go to codemaster, grep is for literal text" is sound and reads as TOTAL. For frontend work whose
   truth is outside the TS project it silently does not apply, and there is no signal saying "the thing you
   are about to grep for is in a sibling repo codemaster does not index". The measured effect is not a
   refusal but MOMENTUM: once in grep mode for the backend repo, the agent stays in grep mode for the TS repo
   too, and the genuinely codemaster-shaped residue goes to grep with it. One line acknowledging the boundary
   ("codemaster answers what the code does, not what the server does — for enforcement, read the service")
   would cost nothing and is what the field reports ask for.

Sibling ask filed inside the same reports, distinct enough to note here and design separately if it grows:
`discrimination_sites` narrowed to a NULLABLE field — "every place that branches on `access` being ABSENT vs
EMPTY". Absent-vs-empty is a recurring privacy-shaped bug class, and it was asked with grep.

Not a request to index Java. The ask is that the perimeter be legible at its edge.

## Свидетельство (field reports, external agents, amiro / amiro-frontend + sibling java `../control-plane`)

- 2026-08-05 — a team-access defect: the verdict came from a markdown spec repo, then the Java resolver, then
  the live DB; TS was the last step. «Steps 1-3 carry the entire verdict, and none of them is a TS symbol
  question … the one repo codemaster indexes was the one I needed least help navigating.» Nearly missed that
  `accessGrantsFrom` collapses `undefined` and `[]` — «which IS a codemaster-shaped question». Wish #1 in
  their own order: boundary-type flagging for generated-API types.
- 2026-08-05 — `member_usages {name:'PaymentV2Dto', member:'refundedAmount'}` answered half the question
  excellently (13 sites, read/write split, «ответ, который grep не даёт в таком виде»); the other half —
  which java mapper writes it, and whether the search projection uses it — took 4 manual steps and 3 greps in
  the java repo, each able to miss silently.
- 2026-08-03 — payment `amount`/`total` changed semantics (now carrying VAT); the second consumer
  (`bi-reports.ts`) was found by REVIEW, not by search, because the edge ran through a string collection key
  and a common field name. Ops used that shift: 0. «Оракул жил не здесь.»
- 2026-08-03 — a codegen/IR track: 0 calls, half the questions about `openapi.json`, half about java. Their
  own conclusion is the momentum mechanism above: the one moment the tool was the right answer (proving no
  producer sends a bare value before deleting `MedicationWriteInput` and changing `unwrap`'s semantics)
  arrived INSIDE a task where it was otherwise useless, so it was missed — the save was an independent
  reviewer, not the tool.
