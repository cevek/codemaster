---
id: t-000100
title: reattach-doc gap rebuild is LF-only
status: backlog
priority: low
type: dx
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:39.000Z'
---
**reattach-doc gap rebuild is LF-only** — `reattachLeadingDoc` rebuilds the comment→decl gap with
`'\n'.repeat(...)`, so in a CRLF file the normalized gap is LF (mixed line endings). The project's
own prettier normalizes on apply; only bites a no-prettier repo on Windows. `dx`·`low`·`cx:S`
