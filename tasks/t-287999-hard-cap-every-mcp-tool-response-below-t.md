---
id: t-287999
title: Hard-cap EVERY MCP tool response below the harness output ceiling (~64KB) at the MCP seam + a per-op × per-output-mode size test matrix
status: done
priority: high
tags:
  - agent-surface
  - correctness
  - dogfood
type: feat
complexity: L
area: render
created: '2026-07-17T13:16:46.168Z'
---
## The invariant (hard rule)
Any MCP tool response ABOVE the harness output ceiling (~65KB observed: "Output too large (65KB). Full output saved to file. Preview (first 2KB)") is persisted to a file by the harness and becomes UNREADABLE in place — the agent sees only a 2KB preview + a file path. So **every codemaster MCP response MUST stay strictly under that ceiling.** This is not per-op-optional; it is a universal boundary guarantee. Discovered via status (t-523883, 66.7KB on a 36-op repo), but it applies to EVERY op — a huge find_usages / source / expand_type / symbols_overview / impact result can blow it too.

## The number
Set a shared constant, e.g. `MCP_RESPONSE_MAX_BYTES` ≈ **60_000** (safe margin below the observed ~65_536 = 64KiB, leaving room for the harness's own JSON framing/encoding). Measure the real threshold and pick a conservative value; make it one constant used everywhere.

## The fix — a TOTAL cap at the MCP seam (backstop over the per-section §12 caps)
The existing §12 caps are PER-DATA-REGION (per-op truncation of a list/type), not a guarantee on TOTAL response size. Add a final total-size cap at the MCP facade boundary (src/mcp), applied to EVERY op response after rendering: if the serialized response exceeds `MCP_RESPONSE_MAX_BYTES`, truncate the tail with an explicit honest marker (`!! OUTPUT CAPPED at NKB — narrow the query / use verbosity:terse / status {op:"X"}`) — consistent with §3.4 (no silent truncation) and §12 verdict-first (the load-bearing verdict/frame is emitted first, so only the re-fetchable bulk is cut, never the honesty channels). status's own fix (terse-by-default) is t-523883; THIS task is the universal backstop so no op can ever exceed the ceiling regardless of its own capping.

## The test matrix (the user's explicit ask)
A test that runs EVERY op × EVERY output mode (terse / normal / full / json / brief where applicable, + sql projections) and asserts the serialized response is < `MCP_RESPONSE_MAX_BYTES`. Drive it on a fixture (or a real large repo) engineered to produce big outputs per op (many usages, huge type, 36-op status, wide sql table). This is the guard that keeps the invariant from regressing as ops/notes grow. Wire it into the differential/e2e suite so CI enforces it.

## Related
- t-523883 — status terse-by-default + CLI brief/op wiring (the acute instance).
- Record the invariant in CONTRIBUTING "Output is the product" + ARCHITECTURE §12.
