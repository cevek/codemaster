---
id: t-146140
title: 'Move the shared dispatch-envelope + result-render vocabulary below the two front doors: `cli/` reaches sideways into `mcp/` for batchToolSchema, normalizeBatchArguments and renderBatch/renderResults'
status: backlog
priority: medium
tags:
  - agent-surface
type: imp
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-198617
  - t-617982
  - t-848858
surface:
  - cli
  - core
  - format
  - mcp
  - ops
audience: internal
evidence: repro
created: '2026-07-28T12:37:27.235Z'
---
`src/cli/` and `src/mcp/` are peer L5 front doors. Three pieces that belong to neither live in
`mcp/`, so the CLI imports sideways to reach them:

- `renderBatch` / `renderResults` (`src/mcp/render-response.ts`) — "render an `OpResult[]`" is
  `format/`'s charter. Same for `mcp/render-dispatch-error.ts`, whose own header already documents
  itself as shared with the CLI.
- `batchToolSchema` (`src/mcp/schema.ts`) — the §11 batch composition envelope, now validating
  input at two independent edges (MCP `arguments`, CLI argv+JSON). A contract with two consumers
  belongs at or below `ops/`, beside `OpRequest`.
- `normalizeBatchArguments` (`src/mcp/op-tools.ts`) — an ENVELOPE normalizer (distinct from §7's
  `ops/intake/` ARG normalizer, so it should not be folded in there), coupled to `splitReserved` +
  `OP_TOOL_RESERVED_KEYS`. Importing it pulls zod + `ops/registry` + the whole tool-descriptor and
  JSON-Schema machinery into the CLI's module graph for one six-line function.

The graph is acyclic today and nothing in `mcp/` imports `cli/`, so this is ownership, not a cycle.

**The blocker, stated so it is not rediscovered:** `render-response.ts` and `render-dispatch-error.ts`
both import `OpResult` / `DispatchError` from `ops/contracts.ts`, and `format/` may not import
`ops/` (`ops/` imports `format/`). The enabling step is moving `OpResult` / `DispatchError` to
`core/` — they are pure dispatch-envelope contracts, exactly core's charter — with `ops/contracts.ts`
re-exporting for compatibility.

End state: dispatch-envelope contract (schema + envelope normalizer + reserved-key set) at or below
`ops/`; result rendering in `format/`; `mcp/` left with the server, tool descriptors, cap-seam,
telemetry and the staleness banner. Then the two facades import only downward.

Until it lands, the sideways edge is sanctioned and deliberate — one implementation validating,
normalizing and rendering a composed call beats two that can drift — and `src/README.md` should say
so rather than leave the layer table reading as if no such edge existed.
