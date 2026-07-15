---
id: t-613878
title: 'Rename Normalized.flagError → intakeError/rejectMessage: the field now also carries the misfit-reject message, name is too narrow'
status: backlog
priority: low
tags:
  - dogfood
  - intake
type: imp
complexity: S
area: render
source: dogfood-jul
created: '2026-07-15T18:21:35.243Z'
---
`Normalized.flagError` (`src/ops/intake/normalize.ts`) now carries both a lift-flags error AND the misfit-reject message; the name reads as flag-only. Behaviorally correct, just misnamed. Rename to `intakeError`/`rejectMessage` — touches `src/daemon/resolve-args.ts` (the consumer).

Source: track A (t-954279) DONE ⚑3 (nit).
