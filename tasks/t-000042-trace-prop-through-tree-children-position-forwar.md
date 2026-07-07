---
id: t-000042
title: "trace_prop_through_tree: children-position forwarding"
status: backlog
priority: low
type: feat
importance: low
complexity: M
area: phase-6
created: '2026-07-08T00:00:41.000Z'
---
**trace_prop_through_tree: children-position forwarding** — a prop passed as the `children` value
(`<Child>{prop}</Child>`) is not traced (the note now honestly scopes this to attribute-position
only; nested ELEMENT children ARE descended). Detect children-position forwarding to close the gap.
`feat`·`low`·`cx:M`
