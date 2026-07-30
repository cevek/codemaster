---
id: t-175176
title: find_missing_i18n_keys reports i18next plural families as missing — the base key never exists by design, so every correct plural is permanent noise
status: backlog
priority: medium
type: bug
complexity: S
area: i18n
source: dogfood-jul
relates:
  - t-004414
  - t-529726
surface:
  - src/ops/find-missing-i18n-keys.ts
audience: external
evidence: repro
created: '2026-07-30T11:17:56.952Z'
---
## Repro (/Users/cody/Dev/amiro)

`t('x.repeatsChip', {count: n})` with an i18next-v4 plural family in the locale (`x.repeatsChip_one`,
`x.repeatsChip_other`, and NO bare `x.repeatsChip`) is reported as a missing key. That is the NORMAL
shape: i18next resolves the suffixed variant at runtime and the base key is not required.

All 22 plural families in `src/i18n/locales/en.json` (`common.more`, `common.nSelected`,
`calendar.serviceCount`, `sales.tile.bookings`, …) lack a base key, so each would be reported the same way
once used with a literal key. Rendering verified live in the browser: "1 repeat" / "2 repeats" resolve
correctly while the op calls the key absent.

Usage site: `src/features/patients/PatientRecordView/panels/ChartItemPanel/PrescriptionRow.tsx:98`.

## Fix

When a literal key K is absent, treat it as PRESENT if the locale holds any `K_<suffix>` from the CLDR
plural set (`_zero|_one|_two|_few|_many|_other`) — optionally only when the call site passes a `count`
option. Reporting it otherwise asserts an absence that is not one, and the noise trains the reader to skip
real misses.
