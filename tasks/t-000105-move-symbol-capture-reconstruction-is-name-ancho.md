---
id: t-000105
title: 'move_symbol: capture reconstruction is name-anchored'
status: backlog
priority: low
type: bug
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:44.000Z'
---
**move_symbol: capture reconstruction is name-anchored** — an unnamed/multi-binding move yields
no single moved name → name-anchored reconstruction is skipped (§2.8 backstops). Unreachable via
today's single-named-symbol target resolver; noted for multi-binding moves. `bug`·`low`·`cx:M`
