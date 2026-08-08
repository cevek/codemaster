---
id: t-000140
title: construction_sites` floods on all-optional target types
status: backlog
priority: high
tags:
  - dogfood
  - dogfood-aug
type: bug
complexity: M
area: render
relates:
  - t-335208
  - t-631139
surface:
  - ops
  - plugins/ts
audience: external
evidence: measured
created: '2026-07-08T00:02:19.000Z'
---
**`construction_sites` floods on all-optional target types** — `ButtonProps` (a big
intersection of `ButtonHTMLAttributes & ClassAttributes & VariantProps & {asChild?}`, every
field optional) matched 5739 candidate literals across unrelated `scripts/openapi-codegen/**`
and even `en.json`, all `confidence=certain` (an `{}`-ish literal IS assignable to an
all-optional type, so it is not strictly a lie — but it is noise). Consider a low-signal guard:
when the target type has zero required fields, demote to `partial` with a "target is all-optional
— matches are weak" note, or rank by field-overlap. `bug`·`low`·`cx:M`

## Свидетельство (field report, 2026-08-05, /Users/cody/Dev/worktrees/amiro/forms-clear-policy)

Second independent instance, and it shows the flood is not a fixture artifact but the DEFAULT shape of the
question this op is reached for. Every PATCH input DTO in that repo is all-optional by design — which is
exactly what makes a payload audit necessary and exactly what makes the op unusable for it.

`construction_sites {name:'UpdateServiceItemInputDto'}` → **449 sites, OUTPUT CAPPED**, dominated by
`scripts/lib/openapi-codegen/*`, `src/local-api/handlers/*` and `src/lib/format-date.ts`. Correct under the
stated semantics (an all-optional interface is satisfied by `{}`) and useless as an answer. The reporter
notes `pathInclude` does not rescue it: "the noise is not in a separable directory, it is in the definition
of the question."

Priority raised `low` → `high` on that evidence: an external agent in a repo it does not maintain, on the
op's headline use case, with no scoping escape.

## Related

`t-631139` is the same symptom from the OTHER vacuity cause — a literal whose own type is `any` is assignable
to everything, so it floods regardless of the target's optionality. One fix surface: rank/suppress on "this
match proves nothing about T", not per-cause.
`t-335208` is the capability that answers the payload-audit question directly
rather than by de-noising this one.
