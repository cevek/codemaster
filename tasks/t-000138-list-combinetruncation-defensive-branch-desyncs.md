---
id: t-000138
title: "list` combineTruncation defensive branch desyncs with the path filter"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: framework-seams
created: '2026-07-08T00:02:17.000Z'
---
**`list` combineTruncation defensive branch desyncs with the path filter** — in `list.ts`
`combineTruncation`, the `!opCapped` branch passes a plugin-reported `view.truncation`
(`{shown,total}`) through VERBATIM. Those counts are PRE-path-filter (the plugin counts before the
op drops entries by `excludedByFilter`), so a plugin that sets `view.truncation` would report a
`shown`/`total` out of sync with the post-filter `entries`. No shipping plugin sets
`view.truncation` today (dead branch), so it never fires — but if one does, the count lies. Fix:
recompute the combined `total` against the post-filter matched set, or document that plugins must
report post-filter counts. `bug`·`low`·`cx:S`
