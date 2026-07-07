---
id: t-000158
title: 'intake: `invalidations_for {name}` could alias to `mutation` (Postel)'
status: backlog
priority: low
type: dx
complexity: S
area: full-density
created: '2026-07-08T00:02:37.000Z'
---
**intake: `invalidations_for {name}` could alias to `mutation` (Postel)** — the canonical arg is
`{mutation}` (a declaration name); an agent reached for `{name}` (fail log, 06-28) and got an
honest reject. `name→mutation` fits the Postel spirit (it IS a declaration name) but is a judgment
call, not a clear bug — add `intake:{aliases:{name:'mutation'}}` only if the off-canonical spelling
recurs. `dx`·`low`·`cx:S`
