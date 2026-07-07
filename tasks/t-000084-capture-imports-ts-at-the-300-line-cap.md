---
id: t-000084
title: "capture/imports.ts` at the 300-line cap"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:23.000Z'
---
**`capture/imports.ts` at the 300-line cap** (297 after the E-g overlay-aware resolver) — the
next addition trips the cap → split-signal. Lift `postMoveResolutionHost` (the
`ModuleResolutionHost` builder + `emptiedByMove` walk, ~80 lines) into a sibling module; the
forward/reverse detectors + `mergedFileSet` stay. `dx`·`low`·`cx:S`
