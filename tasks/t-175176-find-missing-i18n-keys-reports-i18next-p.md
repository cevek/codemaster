---
id: t-175176
title: find_missing_i18n_keys reports i18next plural families as missing — the base key never exists by design, so every correct plural is permanent noise
status: backlog
priority: urgent
tags:
  - dogfood
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

## Why urgent — two facts, stated separately

**1. The false-positive RATIO makes the op unusable as a gate**, not merely imprecise. Field
measurements, four separate runs: **19 of 19**, **26 of 26**, **26 of 26**, and **14 of 26** reported
"missing" rows are correct plural families. At a 100 % floor the only way to read the output is to diff
it against a remembered baseline — which stops working the moment a real miss lands beside a plural.
The op's whole value is that a genuinely missing key is a SILENT defect (i18next renders the raw key
path in the UI, nothing fails), and that value is currently zero.

**2. The DIRECTION of the error produces confident wrong edits.** The op says "key absent"; the
remedy an agent applies is "add the key". Adding the bare `key` beside a correct `key_one`/`key_other`
pair makes i18next select the bare form and drop the pluralisation — a new, silent, user-visible
defect introduced INTO someone else's repository by acting on our answer. This is not an inconvenient
op; it is an op that damages the repo it inspects.

The inverse miss is live too: because only the bare key is ever probed, a plural family missing
`_other` for a locale — the real defect in this family — is never reported.

## Свидетельство — four independent field reports, four amiro worktrees

- 2026-08-03 `qa-booking-sale-chain` — 19/19 false. Samples: `common.nSelected` (`_one`/`_other`),
  `sales.tile.bookings`, `patients.activeCount`, `common.more`, `bundles.row.visits`.
- 2026-08-05 `forms-authz-destructive` — reproduced on three sites, all correct code:
  `use-team-member-save.ts:190` → `team.memberDetail.bookableOff.body`; `:192` → `…andMore`;
  `CalendarMonthView.tsx:129` → `common.more`. Contrast in the same run:
  `team.memberDetail.access.grantAllCovers` is NOT reported only because its author happened to write
  the bare key too — so the answer tracks SPELLING, not translation coverage. A human pass had to be
  spent writing "five «missing» — плюральные формы, ложное срабатывание" into a UX audit report.
- 2026-08-05 `forms-w3-refusal` — 14 of 26 rows false; sample
  `cart-reset-confirm.ts:35 t('sales.addSale.cartReset.body', {count})` vs locale
  `…body_one`/`…body_other`. Reporter verified own keys with a node one-liner over the JSON instead
  of trusting the op.
- 2026-08-05 `qa2-confirmations` — 26/26 false; reporter had to confirm a new key resolved by checking
  it was ABSENT from a 26-line list of known-bad entries.

All four are external agents doing product work in a repo they do not own and cannot reconfigure.
