---
id: t-566356
title: find_usages argsHint has grown past what a per-session inputSchema.description should carry (§11 token tax)
status: backlog
priority: low
tags:
  - agent-surface
type: imp
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T16:23:18.766Z'
---
`find_usages`'s `argsHint` (src/ops/find-usages.ts) is now a single very long line listing every
optional flag with its semantics, and it ships in the MCP `inputSchema.description` EVERY session —
unlike `FIND_USAGES_NOTES`, which §11 keeps behind `status {full}` / `status {op}`.

The same token-tax argument that justifies not adding a new op cuts here: the hint should name the
knobs, the notes should explain them. Trim the hint to flag names + one-word purpose and let the
per-op notes carry the semantics.
