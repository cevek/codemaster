---
id: t-000150
title: 'mutating envelope: `DiffstatEntry` type name + "for the diffstat" comment are stale'
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:29.000Z'
---
**mutating envelope: `DiffstatEntry` type name + "for the diffstat" comment are stale** — the
field is now `touched` (merged per-file counts), but an internal type name/comment still says
diffstat (mutation-support.ts:158-159). Not user-facing; rename for clarity. `dx`·`low`·`cx:S`
