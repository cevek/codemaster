---
id: t-836437
title: 'No op reports what an ASSERTION cast hides: a literal bridged to T by `as` is never checked for excess/missing/mistyped members, so an all-optional contract accepts a literal that barely intersects it'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-228385
audience: external
evidence: reported
created: '2026-08-08T12:06:01.189Z'
---
## What is missing

`construction_sites` answers "which literals are assignable to T". For a literal bridged to T by an
ASSERTION (`as T`, `as Awaited<ReturnType<…>>`) the interesting fact is the opposite one: the cast kills
excess-property checking, and against an all-optional target the literal is "valid" while its key set and
T's key set barely intersect. Nothing reports that.

Wanted — an op, or a flag on `construction_sites`, that takes a type T (or sweeps a path) and, for each site
where a literal is bridged to T by an assertion rather than by a checked assignment, reports:

- members of T the literal does not provide, SPLIT required vs optional — the optional ones are exactly the
  silent case;
- members the literal provides that T does not declare;
- members whose literal type is not assignable to T's declared member type.

Why an op rather than a lint rule: the value is in the TYPE resolution (following
`Awaited<ReturnType<Handlers['x']>>` to the DTO and expanding it) plus the fan-out to the READ sites of the
missing member. "Nobody writes `resolvedDiscount`, and here are the 3 places that read it" is the finding,
and only half of it is local to the cast.

## Свидетельство

2026-08-05, `amiro/qa2-discount-reason`, `src/local-api/handlers/stubs.ts:174-197`. A handler returns an
object literal cast `as Awaited<ReturnType<StoreV2Handlers['previewV2Sales']>>`. The declared return
`SalePreviewDto` is all-optional; the literal invents `subtotal`/`discountAmount`/`total`, omits
`resolvedDiscount` entirely, and puts raw input objects where `PaymentLineDto[]` is declared. The consumer
reads `data?.resolvedDiscount ?? 0`, which is therefore ALWAYS 0 — a whole feature path (sale discounts) is
unprovable under the mock while every gate is green.

Found by reading the handler after a live run disagreed with the screen. Nothing in the current catalogue
would have surfaced it: the literal IS assignable, so `construction_sites` is semantically correct and
useless for the question.

UNVERIFIED against current `main` in the sense of a reproduction here — the report is a field observation of
an ABSENT capability, not of a wrong answer.
