---
id: t-000141
title: shape renderers are not wrapped in try/catch
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:20.000Z'
---
**shape renderers are not wrapped in try/catch** — `condense`'s tag-dispatch calls the renderer
directly; a throwing renderer would escape to the agent (the "never crash" §3.6 contract formally
relies on renderers being throw-free by construction — they are today: only `String()`/asArray
guards). Wrap the dispatch so a throwing renderer yields a loud `!! renderer error ~shape=X`
marker (mirroring the unknown-tag marker), never a stack trace. `dx`·`low`·`cx:S`
