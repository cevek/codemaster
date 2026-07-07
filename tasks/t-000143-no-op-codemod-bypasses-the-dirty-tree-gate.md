---
id: t-000143
title: no-op `codemod` bypasses the dirty-tree gate
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:22.000Z'
---
**no-op `codemod` bypasses the dirty-tree gate** — a pattern that matches nothing reports a
compact zero-change verdict (`changed:0`, `typecheck:{clean:true}` without running tsc — honest,
the edit introduced nothing) but no longer hits the dirty-tree refusal a non-empty codemod would.
Harmless (writes nothing), but a behavior change vs main — confirm intended. `dx`·`low`·`cx:S`
