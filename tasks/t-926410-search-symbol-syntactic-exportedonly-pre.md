---
id: t-926410
title: 'search_symbol syntactic: exportedOnly precision (drop non-exported locals; superset-safe today)'
status: backlog
priority: low
tags:
  - cleanup
  - dogfood
created: '2026-07-14T14:11:56.495Z'
---
On the syntactic path, `exportedOnly:true` currently drops only import/alias re-mentions (never an export), NOT non-exported LOCAL real declarations — so it over-includes (a `const x` that isn't exported still shows). This is superset-safe noise (never a miss), deliberately conservative: a naive "require export modifier" check risks dropping a genuinely-exported decl (`export {x}` re-export, `export default`) → a miss, which is worse than noise. A precise fix must handle all export forms (modifier, export-specifier, default) without under-inclusion. Low priority — over-inclusion is honest under the scoped claim.
