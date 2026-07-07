---
id: t-000078
title: "loose-root monorepo picks the wrong primary for MUTATION (read-path cousin)"
status: backlog
priority: medium
type: imp
importance: medium
complexity: L
area: multi-program
created: '2026-07-08T00:01:17.000Z'
---
**loose-root monorepo picks the wrong primary for MUTATION (read-path cousin)** — the file-driven
nearest-config fix is READ-ONLY: rename / change_signature fan out over `builtContaining` (built-only,
session-order-independent, §2.8-gate-consistent), so an alias-only caller resolving only via a nested
config is CONSISTENTLY not rewritten — a dangling-caller completeness gap in the SAFE always-cold
direction (never a session-dependent or un-gated edit). The mutation analogue of the read fix
(route/load the nearest config for the edit target AND join it to the §2.8 gate) is the cousin.
`imp`·`med`·`cx:L`
