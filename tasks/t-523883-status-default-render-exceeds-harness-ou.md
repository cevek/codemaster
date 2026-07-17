---
id: t-523883
title: status default render exceeds harness output limit (65KB on a 36-op repo) — make it terse-by-default + cap it + wire brief/op through the CLI
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: render
created: '2026-07-17T13:14:54.708Z'
---
Dogfood (repro on /Users/cody/Dev/amiro, 5 plugins → 36 ops): default `status` = ~66.7KB → overruns the harness output cap → truncated/persisted to a file → the first-contact manifest is unreadable in place. Defeats spec-status-as-the-doc.

## Root cause
`renderStatus` (src/format/render/render-status.ts) FULL mode dumps every op with multi-paragraph notes + examples + columns + the concepts block. 36 ops × verbose notes = 65KB. Two defects:
1. **Default is full and UNBOUNDED** — status does NOT apply the §12 output cap (`!! OUTPUT CAPPED`); it emits everything regardless of size.
2. **CLI ignores brief/op** — `src/bin.ts:277` calls `renderStatus(view)` with no options; `status {brief:true}`/`{op}` are silently dropped from the CLI path. (MCP `src/mcp/server.ts:179` DOES pass them → brief works over MCP; the CLI dogfood path doesn't.)

## Fix direction (advisor-worthy — a default-policy call)
Recommended: **invert the default to terse.** status defaults to the brief-style catalogue (names + one-line summaries + plugin/freshness frame); full per-op detail moves behind `status {op:"<name>"}`. Rationale: the MCP tool-list ALREADY carries each op's typed inputSchema + description per §11 — the default status re-dumping all 36 schemas + notes is largely REDUNDANT with what the agent already has every session. status's unique value is the per-repo frame (active plugins, freshness, warm roots, which ops the plugins enable) + concepts — not a re-emission of every op's docs.

Minimum bar regardless of the default: (a) status MUST respect the §12 cap so it can never exceed the harness limit (verdict-first: keep the frame + names, cap the notes tail with `!! OUTPUT CAPPED … status {op:"X"} for detail`); (b) wire brief/op through the CLI (bin.ts) so the dogfood path matches MCP. Update the golden. The per-op notes themselves have grown very verbose (search_symbol ~4 paragraphs) — trimming helps, but the structural fix (terse default) matters more.
