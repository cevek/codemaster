---
id: t-876386
title: 'find_unused_config: package.json top-level blocks and devDeps whose only invoker is a shell/hook file'
status: backlog
priority: low
parent: t-437713
type: feat
complexity: M
area: platform
source: dogfood-jul
audience: external
evidence: reported
created: '2026-07-30T11:22:20.415Z'
---
knip does the devDependency half and knows nothing about `.husky/` or a package.json CONFIG BLOCK keyed by a
tool name. Removing one without the other leaves either a broken `npx` fetch or a knip failure — the edge
nothing models today.

Depends on the same producer surface as its epic siblings; landing it before `dependency_refs` would mean
reimplementing that resolution privately.
