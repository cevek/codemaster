---
id: t-298448
title: find_missing_i18n_keys cannot check a key that lives in a string-literal UNION — the shape hoisted precisely to be checkable is the one shape it never sees
status: backlog
priority: high
tags:
  - dogfood
  - i18n
type: feat
complexity: M
area: i18n
source: dogfood-inbox-aug
relates:
  - t-175176
  - t-529726
surface:
  - ops/find-missing-i18n-keys.ts
  - plugins/i18n
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T11:58:53.960Z'
---
A repo that cares about i18n key safety hoists its keys into a CLOSED string-literal union
(`type ChainStepKey = 'calendar.chainStep.appointment' | 'sales.chainStep.items' | …`) and renders them
through `i18n.t(key, {defaultValue: key})`. `find_missing_i18n_keys` self-declares "literal t() usages",
and such a key never appears as `t('literal')` — it appears as a TYPE. So the op reports nothing about
the union: the declaring file is absent from the missing list AND from `dynamicUsages`, i.e. the op does
not merely decline, it is silently blind.

**Why this is the load-bearing shape, not an edge case.** The union exists to make the keys checkable —
it does constrain call sites, so it LOOKS enforced and a reviewer believes the invariant holds. It does
not: the half that matters (member ⇒ locale entry) is convention only. `defaultValue: key` completes the
silence by rendering the raw dotted path to the operator instead of failing, and it also suppresses
i18next's own missing-key logging. Green typecheck, green lint, green tests, broken user-visible report.
The checker already knows every member of the union; the locale side is what the op already does. The
JOIN is the whole missing piece.

Wanted, either shape:
- `find_missing_i18n_keys` resolves a string-literal-union type flowing into `t()` / `i18n.t()` and
  checks each member; or
- a narrow op — given a type that is a union of string literals, which members are absent from locale X —
  addressable by type name.

Adjacent asks from the same reports, cheap and in the same walk:
- Say WHY each `dynamicUsages` row is dynamic, and resolve the ones whose key is built from a resolvable
  literal set (`` t(`errors.codes.${code}`) `` over an enum). Today it is a bare 151-row file:line dump
  with no verdict, so learning anything costs one read per row.
- Flag `t(key, {defaultValue: …})` on a NON-literal key as its own category: that combination is exactly
  "a missing key can never become visible", and it is cheap to detect.

Generalises past i18n: any closed literal union consumed as a key into a JSON/record (route ids, test
ids, feature flags, icon names) has the same unchecked half.

**Distinct from t-529726**, which is the UNUSED side (lifting the dynamic-`t()` demote by argument type).
This is the MISSING side, and it carries its own claim: a closed union is statically enumerable, so the
"closed union ⇒ safe" belief a repo builds on it is false today, and we are the only tool positioned to
say so. Do not merge them.

## Свидетельство (2 independent reports, 2026-08-03, amiro worktrees)

- `qa-team-calendar` — verbatim question: "does every member of the `ChainStepKey` union have a matching
  entry in `src/i18n/locales/en.json`?" The op returned 19 missing (all plural noise, see t-175176) and
  151 `dynamicUsages`; `src/lib/error-handler.ts` appears in NEITHER list. The reporter established the
  gap only by reading `getErrorMessage` by hand, spotting `defaultValue: key`, and then noticing the
  file's absence from our own dynamic list — by accident, while reading the output for another reason.
  Same repo has `SensitiveActionCode`, `VisitTypeIconKey`, `ChartGateKey` with the same silent half.
  Filed downstream in that repo's own backlog as `t-rx7x45`.
- `qa-booking-sale-chain` — same question twice in real work ("do these three key literals exist in
  en.json?"), keys declared as `const X_STEP_KEY: ChainStepKey = '…'`. Closed the hole by hand with a
  convention, explicitly noting that "that only works because I remembered to; it is a convention, not a
  check".
