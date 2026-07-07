---
id: t-000094
title: move_symbol leaves a namespace+named same-module pair as two statements
status: backlog
priority: low
type: bug
complexity: M
area: ts-refactor
created: '2026-07-08T00:01:33.000Z'
---
**move_symbol leaves a namespace+named same-module pair as two statements** — when dest has
`import * as M from 'm'` and the move brings a named `{ x }` from `m` (or vice-versa), the result
is two statements from `m`. This is NOT foldable — `import { x }, * as M from 'm'` is illegal
syntax, so two statements are mandatory (the import-fold's `hasNamespace` guard skips it). The only
consolidation possible would be rewriting the moved `{ x }` reference to `M.x` (use the existing
namespace binding) — a semantic rewrite of the moved body, well past the import-fold scope. Distinct
from the foldable default+named bare-specifier dup the fold handles; low-value. `bug`·`low`·`cx:M`
