---
id: t-000136
title: W5-d — `isExported` misses a separate `export { X }` / `export default X` statement
status: backlog
priority: low
type: bug
complexity: M
area: framework
created: '2026-07-08T00:02:15.000Z'
---
**W5-d — `isExported` misses a separate `export { X }` / `export default X` statement** —
`functionDeclarations.isExported` reads the `export` modifier on the declaration or its owning
`VariableStatement`; a declaration exported by a later `export { X }` / `export default X`
statement reads `isExported:false` (under-reports). Fix: fold the file's export-specifier set into
the scan. `bug`·`low`·`cx:M`
