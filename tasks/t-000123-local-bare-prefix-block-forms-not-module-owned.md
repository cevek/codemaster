---
id: t-000123
title: :local` bare-prefix / block forms not module-owned
status: backlog
priority: low
type: bug
complexity: M
area: scss
created: '2026-07-08T00:02:02.000Z'
---
**`:local` bare-prefix / block forms not module-owned** — the paren subject form `:local(.foo){}`
is now unwrapped to behave exactly like `.foo{}` (`selector-scope.ts`), but the bare-prefix
`:local .foo {}` and block `:local { .foo {} }` forms are still treated as entangled (descendant /
nested) → demoted to `partial` for `find_unused`, and the cascade reads `:local .foo` as a
descendant. Conservative-honest (never a false `certain`), but `.foo` there is module-local too.
Fix: extend the unwrap to the prefix/block forms (precise per-compound scoping). `bug`·`low`·`cx:M`
