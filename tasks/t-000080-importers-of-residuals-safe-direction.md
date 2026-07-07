---
id: t-000080
title: "importers_of` residuals (safe direction)"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: multi-program
created: '2026-07-08T00:01:19.000Z'
---
**`importers_of` residuals (safe direction)** — (a) a bare relative module arg
(`importers_of {module:'./x'}`) has no canonical anchor → falls back to raw-string match,
over-matching every `./x` (false-LIVE, never false-dead); (b) the target resolves once under
PRIMARY options, so a target named via a SIBLING-only alias drops real sibling importers
(under-report). Both honest-incomplete. Fix: anchor relative args / per-program target.
`bug`·`low`·`cx:M`
