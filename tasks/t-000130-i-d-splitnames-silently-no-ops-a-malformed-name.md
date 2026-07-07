---
id: t-000130
title: "I-d — `splitNames` silently no-ops a malformed name"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: i18n
created: '2026-07-08T00:02:09.000Z'
---
**I-d — `splitNames` silently no-ops a malformed name** — a leading-dot `.t` or multi-segment
`a.b.c` never matches. Under-reports silently (never lies). Reject at the config schema with a
pointed message. `dx`·`low`·`cx:S`
