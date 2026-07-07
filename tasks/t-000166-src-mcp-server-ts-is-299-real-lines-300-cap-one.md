---
id: t-000166
title: src/mcp/server.ts` is ~299 real lines (300 cap) — one line of headroom
status: backlog
priority: low
type: dx
complexity: S
area: correctness
created: '2026-07-08T00:02:45.000Z'
---
**`src/mcp/server.ts` is ~299 real lines (300 cap) — one line of headroom** — the exit-seam track
pushed it to the cap; the next edit forces a split. The natural seam is extracting the per-op
`runOpTool` + the render helpers (`renderResults`/`renderBatch`) into a sibling `render-call.ts`.
`dx`·`low`·`cx:S`
