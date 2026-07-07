---
id: t-000157
title: "intake: `arrayFieldsOf` is coupled to zod-v4 internals (`.def.type`/`.def.innerType`)"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: full-density
created: '2026-07-08T00:02:36.000Z'
---
**intake: `arrayFieldsOf` is coupled to zod-v4 internals (`.def.type`/`.def.innerType`)** — the
schema introspection that derives array-coercion fields reads zod-v4's internal `def` shape; a zod
major bump could silently return an empty set, so scalar→array coercion quietly falls back to
`bad_args` (a DX regression, NOT a lie — the canonical gate still rejects honestly). Guarded: the
`arrayFieldsOf` unit reddens on a shape change. Re-check on a zod bump; consider a public-API
introspection path if zod exposes one. `dx`·`low`·`cx:S`
