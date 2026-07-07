---
id: t-000043
title: "trace_prop_through_tree: VALUE_TEXT_CAP truncation note"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: phase-6
created: '2026-07-08T00:00:42.000Z'
---
**trace_prop_through_tree: VALUE_TEXT_CAP truncation note** — a `derived`-branch attr whose value
text exceeds `VALUE_TEXT_CAP` (120) silently drops the `derives` hop with no per-attr truncation
note (only `SITE_CAP` truncation is surfaced). Narrow (recurse:false leaf only). Surface the cap.
`bug`·`low`·`cx:S`
