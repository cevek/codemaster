---
id: t-000113
title: E-g residual — in-transaction REVERSE import-capture is not overlay-aware
status: backlog
priority: low
type: bug
complexity: M
area: transaction
created: '2026-07-08T00:01:52.000Z'
---
**E-g residual — in-transaction REVERSE import-capture is not overlay-aware** — the FORWARD
pass now seeds its resolver from the cumulative prior-step overlay (`PriorStepState` via
`mergedFileSet`), closing the headline trust-gap — for `extract_symbol`/`move_file`
(`assemblePlan`) AND `move_symbol` (its LS-driven `detectMoveSymbolCaptures` forward path,
seeded with the same `PriorStepState`). The REVERSE pass (`detectReverseImportCaptures`)
stays symmetric on this-step content + pre-transaction disk (both its POST and PRE resolutions),
so a reverse shadow that only manifests through a PRIOR step's move is under-detected. Left
deliberately: E-g is forward-only, an overlay-aware reverse has no red→green yet, and the §7-safe
direction is a missed rare same-typed shadow over a fabricated refusal (§1; §2.8 backstops a
resulting dangle). Close with a positive reverse-shadow-via-prior-step repro, then make the
reverse POST overlay-aware (and decide PRE: prior-only host vs pre-tx disk) under that test.
`bug`·`low`·`cx:M`
