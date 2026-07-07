---
id: t-000127
title: scss css-module shadow-skip is decl-only
status: backlog
priority: low
type: bug
complexity: M
area: scss
created: '2026-07-08T00:02:06.000Z'
---
**scss css-module shadow-skip is decl-only** — `scanCssModuleUsages` shadow-skip treats only
function params + catch vars as shadows of a css-import name; a `const`/`let`/`var` rebind isn't
skipped → that access is mis-counted as a class use (SAFE direction, never a false `certain`-
unused; rare). A correct fix needs block-POSITION-aware shadowing. Do it when observed biting.
`bug`·`low`·`cx:M`
