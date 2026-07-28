---
id: t-000137
title: W5-e — unary-plus / bigint number literals classify as `other
status: backlog
priority: low
type: bug
complexity: S
area: framework
relates:
  - t-000023
surface:
  - plugins/ts
audience: both
evidence: repro
created: '2026-07-08T00:02:16.000Z'
---
**W5-e — unary-plus / bigint number literals classify as `other`** — `value-shape` reads
`NumericLiteral` and a negative `-1` as `number`/`certain`, but a unary-plus `+1` and a bigint
`1n` (`BigIntLiteral`) fall through to `other`/`dynamic`. Honest under-report (never a
false-`certain`), rare in keys. Fix: extend the numeric branch to `+`-prefixed numerics and
`BigIntLiteral`. `bug`·`low`·`cx:S`

**Related:** t-000023 is about how the queries these unclassified literals produce are DESCRIBED — a `+1`/`1n` key falling to `other`/`dynamic` here is what surfaces as an opaque key there.
