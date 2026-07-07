---
id: t-000046
title: 'trace_invalidation: hook-consumer role filter'
status: backlog
priority: low
type: bug
complexity: S
area: phase-6
created: '2026-07-08T00:00:45.000Z'
---
**trace_invalidation: hook-consumer role filter** — `expand` counts ANY `find_usages` ref to a
hook as a subscriber, so a value-read (`const f = useTodos`, no call) would falsely land in
`reRenderComponents` (over-claim). Mount-refs already filter opaque/value-read; mirror it for
hook-consumers (count call-role refs only). Theoretical (rules-of-hooks → hooks are called), but
the over-claim direction. `bug`·`low`·`cx:S`
