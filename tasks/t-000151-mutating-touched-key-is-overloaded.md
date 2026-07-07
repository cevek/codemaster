---
id: t-000151
title: mutating `touched` key is overloaded
status: backlog
priority: low
type: dx
complexity: M
area: render
created: '2026-07-08T00:02:30.000Z'
---
**mutating `touched` key is overloaded** — `string[]` in full mode, structured
`{path,added,removed}[]` in summaryOnly. Documented + typed, but an agent must branch on `mode`.
Design wart; consider distinct keys (`touched` vs `touchedStat`). `dx`·`low`·`cx:M`
