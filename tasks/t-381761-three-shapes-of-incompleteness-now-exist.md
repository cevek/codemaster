---
id: t-381761
title: Three shapes of incompleteness now exist (files / exports / references) and only the PROSE is shared — decide whether the doctrine gets one parameterised home before a fourth appears
status: backlog
priority: medium
parent: t-532530
type: imp
complexity: M
area: correctness
source: dogfood-jul
relates:
  - t-162650
  - t-467009
  - t-633403
  - t-885983
  - t-919920
audience: internal
evidence: measured
created: '2026-07-30T14:54:56.918Z'
---
## The situation, arrived at deliberately

Three ops now state incompleteness, each denominated in a different unit, and each refused to reuse the
others' STRUCTURE for a reason that was correct at the time:

| op family | unit | why it could not reuse the first structure |
|---|---|---|
| `construction_sites` / `discrimination_sites` | FILES walked, per program | the original — `ScanCoverage` + `ops/scan-coverage.ts`, five causes each with its own lever |
| `find_unused_exports` / `find_unused_props` | exports scanned, ONE primary | synthesising a per-program coverage would print `programsScanned`, a claim about a fan that never happened |
| `trace_type_widening` | forward REFERENCES per program | `scanCompleteness` discriminates on `walkedFiles === 0`, so a value with zero refs but a fully-consulted fan would print `!! NOT A VERDICT` over a complete answer |

Each refusal prevented a lie. Together they leave one doctrine — *an empty SCAN is not an empty RESULT; a
shortfall names the lever that can change it; one cause, one remedy* — living in three implementations, with
only the marker strings shared by export.

## Why this is worth a decision rather than drift

t-633403 is the same class one level down (a remedy tail copy-pasted across ~13 op notes, so a wording fix is
13 manual edits). Three structures is where that becomes structural rather than cosmetic: the next op to need
a fourth unit will copy whichever is nearest, and the invariant that all of them encode identically —
"completeness is *did the walk finish*, never *is the result empty*" — is exactly the one that has already been
got wrong twice under review.

## What a decision looks like

Either (a) parameterise one coverage type by UNIT + available levers, and let each op supply its denominator
and its remedy set; or (b) keep three structures and extract the shared INVARIANT into one checked place — a
predicate/assert that a completeness verdict is derived from "walk finished", never from "count === 0", so a
fourth implementation cannot re-introduce the inverted lie.

(b) is cheaper and closes the recurring defect; (a) reduces the surface but risks bending a structure to a
unit it does not fit, which is precisely what the three refusals above were right to avoid. Decide once, then
make the fourth op inherit it rather than re-derive it.
