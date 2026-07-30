---
id: t-562577
title: No op answers 'who reads/writes key K of a string-keyed record' — and the DYNAMIC accessor is precisely what grep cannot resolve, so the fallback is silently unsound
status: backlog
priority: medium
parent: t-560034
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-250147
  - t-902277
audience: external
evidence: repro
created: '2026-07-30T11:18:47.410Z'
---
## Repro (/Users/cody/Dev/amiro, medication contract migration)

The drafts are string-keyed maps, not interfaces:

    src/.../ClinicalEntryPanel/chart-field-defs.ts:174  export type ChartDraft = Record<string, string>

Field definitions are DATA (`{key:'origin', type:'select', …}`) and the renderer reads the draft
dynamically:

    src/.../ClinicalEntryPanel/fields/renderClinicalField.tsx:39
      const value = draft[field.key] ?? field.defaultValue ?? '';

So for key `quantity` / `origin` there is no declared symbol and no declared member. Tried:
`find_usages {name:'quantity'}` (not a symbol), `member_usages` (not a member of `Record<string,string>`),
then fell back to `grep -rn`.

## Why THIS fallback is the unsound one

grep finds the literal sites (`draft.quantity`, `{key:'quantity'}`) and CANNOT find the dynamic one —
`draft[field.key]` never contains the string. That single dynamic site is what the whole fix depended on:
whether it uses `??` or `||` decides if an unset value silently resurrects the field's `defaultValue`. It
was found by reading the renderer; nothing would have pointed there.

## Shape

    record_key_usages {type:'ChartDraft', key:'origin'}   (or {file, key})

returning: literal reads/writes (`draft.origin`, `draft['origin']`), sites writing the key into an object
literal, the DATA declarations naming it (`{key:'origin'}` inside a field-def array), and — flagged
`dynamic`, which is the point — the accessor expressions (`draft[field.key]`) that can reach ANY key of
that record type, so the caller knows a hand-check is required there.

Even just "here are the N dynamic accessors of this record type, any may touch your key" beats grep's
silence and matches the honesty contract better than a hit list that looks complete and is not.

Adjacent, same root cause: `visibleWhen: {key: ChartGateKey, value: string}` gates are data too, so "which
fields are gated on `origin`" is likewise unanswerable.
