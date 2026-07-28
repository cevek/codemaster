---
id: t-848858
title: "`root` inside an op's json args is a reserved key on the MCP facade but a `bad_args` rejection on the CLI — the same call shape answers differently on the two front doors"
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-146140
  - t-198617
  - t-281434
  - t-320098
surface:
  - cli
  - mcp
  - ops/intake
audience: both
evidence: repro
created: '2026-07-28T12:37:04.176Z'
---
`root` sits in `OP_TOOL_RESERVED_KEYS` (`src/mcp/op-tools.ts`) but NOT in `OP_FLAG_KEYS`
(`src/ops/contracts.ts`), which is what the §7 intake layer lifts out of `args` up to the request.

Consequence, both surfaces:

- MCP per-op tool: `find_usages({name:'X', root:'/other/repo'})` — the facade's `splitReserved`
  extracts `root` before the remainder becomes `args`, so it routes correctly.
- CLI: `codemaster op find_usages '{"name":"X","root":"/other/repo"}'` — nothing extracts it, the
  op's own zod gate sees an unrecognized key, and the call fails `DISPATCH bad_args: unrecognized
'root'`.

So the cross-repo addressing documented in the server instructions ("any op or batch request may
carry a top-level 'root'") holds on one front door and not the other, for identical JSON. The CLI
has `--root`, so the capability is reachable — it is the SHAPE that diverges, which is what an
agent copying a documented call between surfaces will hit.

Fix direction: add `root` to `OP_FLAG_KEYS` so the dispatcher-level intake lifts it on every path
(it is already type-validated as `OpRequest.root`), rather than teaching the CLI a second
extraction. Check the §7 anti-drift test — it forbids an op arg colliding with a reserved key, so
promoting `root` to a lifted flag needs that test re-run, not just extended.

Predates the CLI composition work (t-631032); found while checking CLI↔MCP parity there.
