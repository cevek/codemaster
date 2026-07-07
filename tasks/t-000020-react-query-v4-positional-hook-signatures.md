---
id: t-000020
title: react-query v4 positional hook signatures
status: backlog
priority: low
type: feat
complexity: S
area: phase-4
created: '2026-07-08T00:00:19.000Z'
---
**react-query v4 positional hook signatures** — `useQuery(key, fn)` / `useMutation(fn, opts)`
positional forms are NOT detected (v5 object-form only); positional `invalidateQueries(['a'])`
IS handled via the generic arg-shape. `feat`·`low`·`cx:S`
