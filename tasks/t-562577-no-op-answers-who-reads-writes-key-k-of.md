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

## Second instance, from codemaster's OWN source — the key reached through an inline `as` cast

The first instance was a string-keyed draft in an app repo (`ChartDraft = Record<string,string>`, read via
`draft[field.key]`). This one is structurally different and lands in this repo, which makes it systemic
rather than incidental.

Renaming an op's result-data field (`find_unused_exports`' `filterMatchedNoFiles` → `notAVerdict`): the field
is not a member of ANY named type. It exists only as an inline structural cast at each reader —
`(data as { filterMatchedNoFiles?: string }).filterMatchedNoFiles` in the op's own `table.notes(data)`, plus
test files casting the same payload to a locally-declared view type. **Producer and consumers are joined by
the STRING KEY, not by a shared type.**

What the catalogue does with that question:

- `member_usages {name:'notAVerdict'}` → `bad_args`: it needs a TYPE target plus a member, and there is no
  type to address (an anonymous cast literal has no name and no declaration to pass). An honest refusal — the
  gap is that the question has no reachable FORM.
- `find_usages {name:'filterMatchedNoFiles'}` does not apply: the key is a property in an object literal / a
  type-literal member, not a referenced symbol binding.

So a rename spanning op → table projection → tests fell back to grep. Here it happened to be safe (2 src + 1
test file) — but nothing in the answer SAID it was complete, and a fourth reader spelling
`data['filterMatchedNoFiles']` would have read identically to a miss.

**Why this makes the class systemic in this repo:** a `TableSpec.rows/notes(data)` reads its op's payload
through an inline cast BY CONSTRUCTION — the seam is `JsonValue`. So every op-result field in codemaster is
renamed under exactly this blind spot.

The shape that would reach it: address a member by NAME alone when no named type declares it — "this string
key, as a property, wherever a structural type declares it or an object literal supplies it" — stamped
honestly as `confidence: partial` / `provenance: syntactic`, since such a set is name-based and cannot prove
identity across unrelated types. Still strictly better than grep: it excludes the same string in comments and
string literals, and it states its own scope.
