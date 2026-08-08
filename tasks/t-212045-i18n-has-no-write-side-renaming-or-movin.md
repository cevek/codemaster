---
id: t-212045
title: 'i18n has no WRITE side: renaming or moving a key is grep+sed across every locale and every t() site, and the dynamic sites text search cannot see are exactly the ones that break'
status: backlog
priority: high
tags:
  - dogfood
  - i18n
type: feat
complexity: L
area: i18n
source: dogfood-inbox-aug
relates:
  - t-529726
surface:
  - ops
  - plugins/i18n
audience: external
evidence: reported
created: '2026-08-08T11:59:21.966Z'
---
The i18n READ side is covered (`i18n_lookup` resolves key→value+usages and value→key;
`find_unused_i18n_keys` / `find_missing_i18n_keys` audit both directions). There is no WRITE op, so
renaming a key — a routine consequence of copy changing meaning — is done by hand: edit every
`src/i18n/locales/*.json`, then `grep -rl` + `sed` over `t('…')` call sites, then re-run the gate and
hope nothing dynamic pointed at the old key. That is the manual editing every other mutating op exists
to prevent, and it is unsafe in four ways a text search cannot fix:

- **A key is a PREFIX as well as a leaf.** Renaming `sales.addSale` must carry its whole subtree; a sed
  on a leaf name cannot express that.
- **Plural / context suffixes belong to the same key.** `key_one` / `key_other` are not matched by a sed
  on the bare name, so a rename silently splits a plural family (the t-175176 defect, self-inflicted).
- **Locale files must move in lockstep.** Renaming in `en.json` alone turns the next
  `find_missing_i18n_keys` run red for every other locale.
- **The dynamic sites are invisible to text.** The plugin already knows which usages are dynamic
  (`` t(`a.${x}`) ``, `t(row.labelKey)`), so it can REFUSE — or flag — a rename whose namespace has a
  dynamic consumer, instead of leaving it silently broken. A grep cannot even enumerate them.

Wanted: `rename_i18n_key {from, to}` with the same contract as `rename_symbol` — dry-run by default,
explicit `apply`, git dirty gate, atomic write, post-edit verification — editing the locale files and
rewriting literal `t()` usages together, prefix-aware and suffix-family-aware. Same argument for
`move_i18n_key` between namespaces, which is the common shape when copy is regrouped after a refactor.

## Свидетельство (2026-08-05, `amiro/forms-sales-money`)

Sales-panel work where `sales.addSale.itemsUnknownRefusal` stopped describing its behaviour (the rule it
named was removed; the string stayed as a title). Renaming it to `itemsUnknownTitle` was done entirely by
hand — every locale JSON, then `grep -rl` + `sed` over the call sites — with the reporter noting the
residual risk of a dynamic consumer that neither step could see.
