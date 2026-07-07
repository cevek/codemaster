---
id: t-000126
title: cross-file source order is unknown
status: backlog
priority: low
type: feat
complexity: L
area: scss
created: '2026-07-08T00:02:05.000Z'
---
**cross-file source order is unknown** — we don't model `@use`/`@forward`/import order, so a
cross-module specificity+importance tie is reported as `ambiguousWith` co-winners at `partial`
(by design, §19). A real dart-sass eval would resolve it. `feat`·`low`·`cx:L`
