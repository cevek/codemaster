---
id: t-966927
title: No op answers "which string literals CO-VARY with this one" — literals equal only by convention must change in lockstep, and the failure is 100% silent
status: backlog
priority: high
parent: t-560034
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-288409
  - t-479658
  - t-562577
audience: external
evidence: reported
created: '2026-08-08T12:02:47.792Z'
---
## What is missing

A string literal that is compared against, or assigned to, the same slot as another literal is bound to it
by CONVENTION, not by any type. Nothing in the catalogue reports that binding, so changing one of the set
and missing another produces no type error, no failing test, and no runtime error — only wrong behaviour.

The question: given a slot (a property, a record key, a config field flowing into `draft[key]`), list every
literal that REACHES it or is COMPARED WITH it, so the co-varying set is visible as a set.

Why the existing ops do not reach it:

- `find_usages` on the property gives sites, not literal-level co-variance.
- `member_usages` needs a MEMBER, and the config-driven form draft is `Record<string, string>` — there is
  no member to address (same root as t-562577).
- `discrimination_sites` covers a union TYPE; here both sides are `readonly string[]` inside one object
  literal, so the checker has nothing to say.
- `trace_type_widening` is the nearest existing op and answers a different question (where a narrowed type
  widens), not "where is a value of this slot written as a literal".

Second, narrower form asked for in the same report: an INTRA-ARRAY structural invariant — "this config
object's `visibleWhen.value` must be one of the sibling field's `options`". Both sides are literals in one
array; today it is caught only by a hand-written unit test, and only if the author already knew to look.

## Свидетельство

2026-08-05, `amiro/forms-clinical-editor`. Refactoring a React draft from display labels to wire enum values
across ~20 files. The dangerous part was never a type error: the UI word `'SOAP'` lived in seven places — a
payload builder (`draft.template !== 'Basic'`), a gate on a DESTRUCTIVE delete+repost path, two read
surfaces, and four `visibleWhen: {key:'template', value:'SOAP'}` entries in a config array. Moving the draft
to `'SOAP_NOTE'` required all seven to move in lockstep; missing one means the builder sends a SOAP body for
a quick note and the visibility gate renders no body fields at all — nothing typechecks red, nothing fails.

Generality claimed by the reporter: `Record<string, string>` drafts are the NORMAL shape for config-driven
forms, and they erase exactly the member identity the semantic ops key on. The class is "two literals equal
only by convention", and its failure mode is fully silent — which is the class proof-carrying answers are
best positioned to own.
