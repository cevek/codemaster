---
id: t-000044
title: 'trace_field_to_render: non-visual host-attr over-claim'
status: backlog
priority: low
type: bug
complexity: S
area: trace
created: '2026-07-08T00:00:43.000Z'
---
**trace_field_to_render: non-visual host-attr over-claim** — an intrinsic-attr read is uniformly
`certain rendered-in` and counted in `renderedBy`, but `key={u.id}` / `ref` / `on*` handlers bind to
the host without VISUALLY rendering the value → over-claims "renders". Common case (value / aria /
alt / title / placeholder / href) is correct. Demote key/ref/on\* attr bindings to `partial` (or a
distinct relation). `bug`·`low`·`cx:S`
