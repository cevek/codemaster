---
id: t-000107
title: move_symbols({names:[],dest})` bulk-move sugar (optional)
status: backlog
priority: low
type: feat
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:46.000Z'
---
**`move_symbols({names:[],dest})` bulk-move sugar (optional)** — dogfood ask: splitting a large
file means moving N top-level symbols into one dest. The underlying need (one §2.8 gate, atomic,
importers repointed once) is now MET by a `transaction` whose steps are N `move_symbol`s. A
dedicated bulk op would only save the agent from authoring the steps array — pure ergonomics, not
a capability gap. Defer unless the transaction form proves too verbose in practice. `feat`·`low`·`cx:M`
