---
id: t-000060
title: 'module-resolve`: bundler-only aliases + a dedicated module'
status: backlog
priority: low
type: feat
complexity: M
area: platform
created: '2026-07-08T00:00:59.000Z'
---
**`module-resolve`: bundler-only aliases + a dedicated module** — relative AND tsconfig-`paths`
aliased `.scss` importers now resolve (via the shared `alias-paths.ts`, Task J), but a
bundler-only alias absent from tsconfig `paths` stays invisible (the same resolution boundary
codemaster applies repo-wide), and there's still no dedicated `module-resolve` module. `feat`·`low`·`cx:M`
