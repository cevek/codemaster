---
id: t-000048
title: 'trace_invalidation: queryKey-label placement'
status: backlog
priority: low
type: imp
complexity: S
area: phase-6
created: '2026-07-08T00:00:47.000Z'
---
**trace_invalidation: queryKey-label placement** — the queryKey node's `label` is minted by
`summarizeQueryKey`, a format-layer helper, yet it ships in `format:'json'` and the sql `from`/`to`
columns (it is data, not just text). Move queryKey-label minting onto the react-query view (a
`keyLabel`) — the only node label borrowing from `format`; sql-skew is already closed by the
render-contract guard. `imp`·`low`·`cx:S`
