---
id: t-000023
title: dynamicKeyedQueries` note wording
status: backlog
priority: low
type: bug
complexity: S
area: framework
created: '2026-07-08T00:00:22.000Z'
---
**`dynamicKeyedQueries` note wording** — for a BROAD edge (`invalidateQueries()` with no key)
the opaque-keyed queries DO appear in `affects` as `dynamic` (matchKey's opaque-check follows
the broad-check), so the op note "not listed under affects" is imprecise. Cosmetic — no false
`certain`; tighten to "not listed under a CONCRETE invalidation's affects". `bug`·`low`·`cx:S`
