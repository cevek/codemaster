---
id: t-000099
title: "extract import-fold misses different-specifier-same-after-rewrite"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:38.000Z'
---
**extract import-fold misses different-specifier-same-after-rewrite** —
`foldSameModuleImports` runs BEFORE `assemblePlan`'s `rewriteImports`, so two imports that become
same-module only AFTER a specifier rewrite (e.g. `'./a'` and `'@/a'` resolving to one moved file)
are not folded. Rare; acceptable today. `bug`·`low`·`cx:M`
