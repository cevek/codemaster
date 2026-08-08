---
id: t-294436
title: i18n_lookup `prefix` matches whole dot SEGMENTS but reports matched=N with no marker — five sibling keys under the given string are silently absent and the answer reads complete
status: backlog
priority: high
tags:
  - dogfood
  - honesty
  - i18n
type: bug
complexity: S
area: i18n
source: dogfood-inbox-aug
surface:
  - ops
  - plugins/i18n
audience: external
evidence: repro
created: '2026-08-08T12:00:06.233Z'
---
`i18n_lookup {prefix}` matches on DOT-SEGMENT boundaries (`prefix` or `prefix.`), not on string prefix —
but the argument is named `prefix` and the op summary says "key/prefix", so a caller reads it as a string
prefix. When the given string ends mid-segment the op returns the segment-exact key alone and prints
`matched=1` with no truncation, partial or hint marker. The answer is then indistinguishable from a
genuine "this key family has one member", which is a confident wrong answer — worse here than a FAIL,
because the caller acts on it.

Remedy, in preference order:
1. Make `prefix` a real string prefix (`key.startsWith(prefix)`), which is what the name promises;
   segment scoping is then simply a `prefix` ending in `.`.
2. If segment semantics are deliberate, state them in `status {op:'i18n_lookup'}` notes AND emit a hint
   on a zero/one-match answer whose prefix ends mid-segment: "N keys start with this string but are not
   under it as a segment — use `prefix:'sales.detail'`".

Either way the silence is the defect: a selector that dropped candidates must say so (§3.4).

## Свидетельство (2026-08-05, `amiro/qa2-settlement-panel`)

`i18n_lookup {prefix:"sales.detail.receipt"}` → exactly one row (`sales.detail.receipt`, en=Receipt),
`matched=1`, no marker. `src/i18n/locales/en.json` also holds `sales.detail.receiptDownload`,
`receiptEmail`, `receiptRefundDownload`, `receiptEmailSent`, `receiptNoPermission` — five siblings that
literally start with the given string, silently absent. Control: `{prefix:"sales.markUnpaid"}` returns
all 11 children correctly. The reporter took `matched=1` as complete, concluded the receipt family had
one key, and found the other five only by falling back to
`python3 -c "json.load(open('src/i18n/locales/en.json'))"` — the exact grep-style fallback the op exists
to replace.

Minor, same report, no change wanted: `{key:"…", prefix:true}` fails with
`bad_args: prefix: expected string, received boolean`, which the reporter calls correct and its
"— valid: {…}" tail sufficient. Noted only because `prefix` reading as a boolean flag is a natural first
guess given the "key/prefix" phrasing.

## Confirmed in current `main` (source-level)

`src/plugins/i18n/plugin.ts:171-172` — the lookup filter is
`key === filter.prefix || key.startsWith(\`${filter.prefix}.\`)`, i.e. segment-exact by construction, with
no marker emitted for the string-prefix candidates it drops. `plugin.ts:239-247` applies the identical
rule to `find_unused_i18n_keys` (comment: "segment-aware, identical to i18n_lookup"), so the fix must
cover both call sites or state the divergence.
