---
id: t-337633
title: "CLI/MCP `op` under format:'json': a DISPATCH error emits non-JSON text with exit 0 — a `| jq` trap on the success exit code"
status: done
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-15T20:11:38.492Z'
---
**Found during dogfood (t-607963 review, verified live).** On both the MCP path (`mcp/server.ts:renderOne`) and the CLI `op --format json` path (`bin.ts`), a DISPATCH-level error (`'error' in result` — e.g. `unknown_op`, dispatch bad-args) renders as plain `DISPATCH <kind>: <msg>` text, NOT JSON, even under `format:'json'`. The CLI `op` path additionally returns **exit 0** on that branch, so a `codemaster op … --format json | jq` consumer gets an unparseable payload on a success exit code.

This is EXACT parity between CLI and MCP (deliberate — the CLI mirrors `renderOne`), so it is NOT a CLI-specific divergence; fixing the CLI alone would break that parity. Proper fix spans the shared render surface (`mcp/server.ts` renderOne + the CLI op loop): under json, a dispatch error should serialize as a JSON error envelope (and the CLI should exit non-zero). A structured `ok:false` ToolFailure already renders as JSON correctly via `renderResultJson`; only the dispatch-error branch is plain text.

Scope note: touches the MCP render path (shared engine), out of the CLI-robustness track's border. Deferred from t-607963 as a [should-fix].
