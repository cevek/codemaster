---
id: t-777834
title: A key referenced by a bare string literal (labelKey tables) reads as fully unused — the verdict deletes locale strings a live screen renders
status: backlog
priority: high
tags:
  - dogfood
  - honesty
  - i18n
type: feat
complexity: M
area: i18n
source: dogfood-inbox-aug
relates:
  - t-529726
surface:
  - ops
  - plugins/i18n
audience: external
evidence: reported
created: '2026-08-08T12:01:00.222Z'
---
Holding i18n keys in tables and resolving them later is an established idiom
(`{value:'ACTIVE', labelKey:'patients.carePlans.status.active'}`, rendered elsewhere as
`t(option.labelKey)`). For such a key `i18n_lookup` returns `usages (0)` and `find_unused_i18n_keys`
lists it as unused, with nothing distinguishing:

- "no occurrence of this key anywhere in the source" — genuinely dead, from
- "occurs as a bare string literal, just not inside a `t()` call" — live.

Both are strings the LS can see. Acting on the verdict deletes a locale string a live screen renders, and
the failure is silent (i18next falls back to echoing the key path to the user). This is a false CERTAIN
verdict on the destructive side, so the honest floor matters more than the precision: report bare
string-literal occurrences of the key anywhere in TS/TSX as a weak/`partial` usage class —
`usages (0 direct, 1 literal): src/…/CarePlanStatusPill.tsx:14`. Even without proving the literal ever
reaches `t()`, surfacing it converts a false "dead" into an honest "can't claim". Same treatment for
`find_unused_i18n_keys`: a `literal-only` bucket beside the dynamic-namespace demotion it already does.

Distinct from t-529726 (which bounds a dynamic `t()` CALL by its argument type) — this is the reverse
direction, a search for the KEY's own literal occurrences, and it needs no checker inference to be
useful.

## Свидетельство (2026-08-05, `amiro/qa2-hide-conditions-tab`)

Sites: `src/api/hooks/usePatientsCarePlans.ts:47`,
`src/features/patients/PatientsView/PatientsCarePlansView/CarePlanStatusPill.tsx:14-17`.

The cost is already structural, not hypothetical: deciding the shape of a tab table, the reporter chose
`label: t('patients.tabs.conditions')` over the idiomatic `labelKey: 'patients.tabs.conditions'` SOLELY
because the latter would have made three live keys look unused to this tooling. Our verdict is shaping
the inspected repo's code, in the wrong direction.
