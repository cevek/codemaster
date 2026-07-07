---
id: t-000102
title: fold-imports leaves an own-line leading comment of a deleted duplicate import hanging
status: backlog
priority: low
type: dx
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:41.000Z'
---
**fold-imports leaves an own-line leading comment of a deleted duplicate import hanging** —
`deleteLine` removes the import line from its `import` token, not from a comment above it, so a
`// note` on its own line above a folded-away duplicate is orphaned. Rare (a comment on a duplicate
import); §2.8 doesn't care (comment). `dx`·`low`·`cx:S`
