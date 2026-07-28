---
id: t-000127
title: scss css-module shadow-skip is decl-only
status: backlog
priority: low
type: bug
complexity: M
area: scss
relates:
  - t-000128
surface:
  - plugins/scss
  - plugins/ts
audience: both
evidence: repro
created: '2026-07-08T00:02:06.000Z'
---
**scss css-module shadow-skip is decl-only** — `scanCssModuleUsages` shadow-skip treats only
function params + catch vars as shadows of a css-import name; a `const`/`let`/`var` rebind isn't
skipped → that access is mis-counted as a class use (SAFE direction, never a false `certain`-
unused; rare). A correct fix needs block-POSITION-aware shadowing. Do it when observed biting.
`bug`·`low`·`cx:M`

**Related:** t-000128 (i18n by-identity scan) states the identical defect and the identical fix — a `const`/`let`/`var` rebind is not treated as a shadow, and a sound skip needs block-POSITION-aware shadowing. The two differ in blast radius: this side under-reports (safe), the i18n side FABRICATES a missing row.
