---
id: t-000159
title: 'doc-hygiene: dangling decimal-`§` refs in `src/` comments'
status: backlog
priority: low
type: dx
complexity: S
area: render
created: '2026-07-08T00:02:38.000Z'
---
**doc-hygiene: dangling decimal-`§` refs in `src/` comments** — several code comments cite
old decimal spec numbering (`§4.6`/`§5.5`/`§2.3`/`§4.1`/`§5.1` in `sql-batch.ts`, `multi-root.ts`,
`registry.ts`) that doesn't resolve to ARCHITECTURE.md's flat `§1..§19`. Read as internal
task-shorthand. Sweep to real `§` anchors or drop the sigil so the cross-ref convention stays
meaningful. `dx`·`low`·`cx:S`
