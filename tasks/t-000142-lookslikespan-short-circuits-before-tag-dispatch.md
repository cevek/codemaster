---
id: t-000142
title: looksLikeSpan` short-circuits before tag-dispatch
status: backlog
priority: low
type: bug
complexity: S
area: render
created: '2026-07-08T00:02:21.000Z'
---
**`looksLikeSpan` short-circuits before tag-dispatch** — `condenseSpans` renders a top-level
span-shaped object (`file`+`line`+`col`+`endLine`+`text`) as a loc string BEFORE checking
`~shape`; so if a future op tagged a raw span-shaped row, its `~shape` would leak into the output
at `full`. No op does this today (usage/group-row/list-entry carry no top-level `endLine`+`text`).
Latent footgun: check `~shape` before `looksLikeSpan`. `bug`·`low`·`cx:S`
