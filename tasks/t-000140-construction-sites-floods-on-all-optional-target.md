---
id: t-000140
title: "construction_sites` floods on all-optional target types"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: density
created: '2026-07-08T00:02:19.000Z'
---
**`construction_sites` floods on all-optional target types** — `ButtonProps` (a big
intersection of `ButtonHTMLAttributes & ClassAttributes & VariantProps & {asChild?}`, every
field optional) matched 5739 candidate literals across unrelated `scripts/openapi-codegen/**`
and even `en.json`, all `confidence=certain` (an `{}`-ish literal IS assignable to an
all-optional type, so it is not strictly a lie — but it is noise). Consider a low-signal guard:
when the target type has zero required fields, demote to `partial` with a "target is all-optional
— matches are weak" note, or rank by field-overlap. `bug`·`low`·`cx:M`
