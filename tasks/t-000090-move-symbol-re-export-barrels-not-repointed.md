---
id: t-000090
title: 'move_symbol: re-export barrels not repointed'
status: backlog
priority: medium
type: feat
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:29.000Z'
---
**move_symbol: re-export barrels not repointed** — the LS "Move to file" rewrites DIRECT
importers but leaves `export { X } from './source'` barrels (and default-export importers)
dangling → the §2.8 gate honestly REFUSES the whole move. Close by supplementing the LS edits
with codemaster's own barrel-specifier rewrite. `feat`·`med`·`cx:M`
