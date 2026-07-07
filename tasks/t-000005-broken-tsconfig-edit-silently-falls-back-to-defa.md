---
id: t-000005
title: broken-tsconfig edit silently falls back to default options + glob-everything
status: backlog
priority: low
type: bug
complexity: S
area: bug-sweep
created: '2026-07-08T00:00:04.000Z'
---
**broken-tsconfig edit silently falls back to default options + glob-everything** —
`single.ts` `parseConfig`/`loadFileList` discard `parseJsonConfigFileContent` errors (and a
malformed-JSON edit yields `config ?? {}`), so an edit that breaks the tsconfig silently
re-globs under DEFAULT options instead of failing/noting. The result set changes with no
`FreshnessNote` — a silent behaviour swap (mild §3.5/§3.6 honesty gap). Surface a note (or
keep the prior parse) when the re-parse has `errors`. `bug`·`low`·`cx:S`
