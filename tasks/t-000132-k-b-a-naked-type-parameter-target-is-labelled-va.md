---
id: t-000132
title: K-b — a naked type-parameter target is labelled `value
status: backlog
priority: low
type: bug
complexity: S
area: impact-usages
created: '2026-07-08T00:02:11.000Z'
---
**K-b — a naked type-parameter target is labelled `value`** — `construction_sites` at a bare
type parameter `T` falls through `targetKind` to `value`. Still scanned + correctly `partial`
via `isGenericTarget`, so no honesty issue — cosmetic mislabel on a degenerate input.
`bug`·`low`·`cx:S`
