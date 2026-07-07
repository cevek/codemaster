---
id: t-000129
title: I-c — a `tsconfig` `paths`/`baseUrl` edit leaves the identity scan on STALE compiler options
status: backlog
priority: low
type: bug
complexity: M
area: i18n
created: '2026-07-08T00:02:08.000Z'
---
**I-c — a `tsconfig` `paths`/`baseUrl` edit leaves the identity scan on STALE compiler options**
until a structural reindex re-globs (`ls-host` caches `parsed.options`; an in-place edit bumps
`projectVersion` but resolves against the old `@/*` mapping). Niche. `bug`·`low`·`cx:M`
