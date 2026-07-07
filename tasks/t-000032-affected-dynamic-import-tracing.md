---
id: t-000032
title: 'affected: dynamic-import tracing'
status: backlog
priority: low
type: feat
complexity: L
area: impact-usages
created: '2026-07-08T00:00:31.000Z'
---
**affected: dynamic-import tracing** — `importersOf` follows only static import/export; a test that
lazily `import('./x')`/`require()`s a changed module is silently skipped (the op honestly scopes
`complete` to the static trace, but the test is still missed). Tool-wide, inherited from
`importersOf`. `feat`·`low`·`cx:L`
