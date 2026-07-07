---
id: t-000152
title: find-usages.ts` is at exactly 300 real lines (the cap, no headroom)
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:31.000Z'
---
**`find-usages.ts` is at exactly 300 real lines (the cap, no headroom)** — passes eslint
`max-lines`, but any further edit busts it. Pre-emptive extraction (e.g. the hoist helpers to a
sibling) before the next change. `dx`·`low`·`cx:S`
