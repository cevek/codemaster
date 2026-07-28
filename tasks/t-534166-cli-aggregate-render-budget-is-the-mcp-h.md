---
id: t-534166
title: 'CLI aggregate render budget is the MCP harness ceiling (45KB): `batch --return all` can omit sections on a surface that has no output limit'
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T12:28:30.696Z'
---
`codemaster batch … --return all` renders through `renderBatch` → `joinSectionsCapped`
(`src/mcp/render-response.ts`), whose `AGGREGATE_BYTE_BUDGET` is `MCP_RESPONSE_MAX_BYTES - 15_000`
≈ 45 KB. That budget exists for the MCP seam: above the harness output ceiling a response is
persisted to a file and the agent sees a preview. A CLI one-shot writes to stdout and has no such
ceiling, so on that path the budget can omit whole producer sections for no reason of its own —
with each per-section render already bounded by `RENDER_CHAR_CAP` (20 000 chars), three producers
can cross it.

It is NOT a silent truncation — the omission carries the `!! OUTPUT CAPPED — N more section(s)
omitted` marker, so the §3.4 contract holds. It is a capability question: the surface most likely
to run a wide `--return all` audit is the one being trimmed for a constraint it does not have.

The counter-argument, and why this is filed rather than fixed: an agent reads CLI stdout through a
tool wrapper that has its OWN output ceiling, so lifting the budget to Infinity trades codemaster's
explicit marker (which names the remedy: re-run sections individually) for an opaque cut made
somewhere else. Any fix has to decide whose ceiling is being respected, which is a design call, not
a constant change.

Shape of a fix if taken: make the budget a parameter of `renderBatch`/`renderResults` with the
current constant as the default, and let the CLI pass its own.
