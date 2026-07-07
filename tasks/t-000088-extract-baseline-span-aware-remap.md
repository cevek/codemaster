---
id: t-000088
title: "extract baseline: span-aware remap"
status: backlog
priority: medium
type: bug
importance: medium
complexity: L
area: ts-refactor
created: '2026-07-08T00:01:27.000Z'
---
**extract baseline: span-aware remap** — a pre-existing error relocated INTO an extracted block
can read as `introduced` (path+line shift defeats the path-only baseline remap, §1b). Disclosed
via a hedge note today; real fix is a span-aware baseline remap. `bug`·`med`·`cx:L`
