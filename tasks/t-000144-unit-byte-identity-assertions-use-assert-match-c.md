---
id: t-000144
title: unit byte-identity assertions use `assert.match` (contains), not exact
status: backlog
priority: low
type: dx
complexity: S
area: render-contract
created: '2026-07-08T00:02:23.000Z'
---
**unit byte-identity assertions use `assert.match` (contains), not exact** — the hermetic
render-compact suite pins outputs with `match`/`doesNotMatch` (pre-existing style), so a trailing
append would slip a strict byte check; the renderer ports were verified by reading. New multi-line
forms (`name-survives`/`target-ref`/`css-coextract`) are pinned only structurally (they were
explosions — no prior bytes). Tighten to exact-string where it matters. `dx`·`low`·`cx:S`
