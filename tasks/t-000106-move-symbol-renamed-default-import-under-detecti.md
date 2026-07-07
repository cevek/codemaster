---
id: t-000106
title: "move_symbol: renamed default-import under-detection"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:45.000Z'
---
**move_symbol: renamed default-import under-detection** — a locally-renamed default import of a
moved `export default` isn't reconstructed. Unreachable today (the LS doesn't rewrite
default-export importers → the gate refuses the dangle first). `bug`·`low`·`cx:M`
