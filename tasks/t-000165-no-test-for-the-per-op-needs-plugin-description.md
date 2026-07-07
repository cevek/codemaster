---
id: t-000165
title: "no test for the per-op `needs:<plugin>` description tag"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:44.000Z'
---
**no test for the per-op `needs:<plugin>` description tag** — `buildOpToolDescriptor` adds a
`[needs: i18n]`-style tag from `op.requires`, but no test asserts it appears (the e2e covers
the call-time `unavailable`, not the advertised tag). `dx`·`low`·`cx:S`
