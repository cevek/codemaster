---
id: t-000109
title: 'move_symbol: no positive capture fixture'
status: backlog
priority: low
type: dx
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:48.000Z'
---
**move_symbol: no positive capture fixture** — the reconstruction/over-refusal guard is only
exercised by the happy path (captures empty). A deterministic positive repro is hard with the
LS's correct resolver; add if a real case surfaces. `dx`·`low`·`cx:M`
