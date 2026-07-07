---
id: t-000008
title: '**`SPAN_TEXT_CEILING == RENDER_CHAR_CAP` (20_000)'
status: backlog
priority: medium
type: bug
complexity: S
area: render
created: '2026-07-08T00:00:07.000Z'
---
**`SPAN_TEXT_CEILING == RENDER_CHAR_CAP` (20_000) — one large span can fill the whole render
budget** — `src/plugins/ts/spans.ts`. A single proof span allowed up to the same 20K as the
whole-output cap means one big declaration body consumes the entire `bulk` region; the
envelope-seam fix keeps the honesty channels alive, but the data itself is reduced to one
truncated span. Lower the per-span ceiling well under the output cap (leave room for ≥a few
spans + the honesty tail), or budget spans against the remaining output room. `bug`·`med`·`cx:S`
(plugins/ts boundary — not in the envelope-seam scope.)
