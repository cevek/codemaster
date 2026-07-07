---
id: t-000121
title: "stylesheet-extension matching is case-sensitive"
status: backlog
priority: low
type: bug
importance: low
area: scss
created: '2026-07-08T00:02:00.000Z'
---
**stylesheet-extension matching is case-sensitive** — `isStylesheetFile`/`isCssModuleFile`
(scss plugin) and the TS `cssModuleUsages` scanner (`css-modules.ts` `/\.(scss|sass|css)$/`)
are all case-sensitive, so `foo.MODULE.css` over-demotes to `partial` (treated global) and
`x.module.CSS` isn't indexed at all. CONSISTENT between gate and scanner (conservative — a
`partial` is never a false `certain`), so not a lie; fix only if an uppercase-extension repo is
in scope. `bug`·`low`
