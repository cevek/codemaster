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
## The false claim is fixed; the budget VALUE is the residual

`renderBatch`/`renderResults` → `joinSectionsCapped` (`src/mcp/render-response.ts`) is the shared
aggregate render for BOTH front doors, bounded by `AGGREGATE_BYTE_BUDGET`
(`MCP_RESPONSE_MAX_BYTES - 15_000` ≈ 45 KB). Its omission marker no longer attributes the cut to
"the size ceiling" — it names codemaster's own aggregate bound, which is true on either transport.
A one-shot CLI has no harness ceiling, so justifying a real cut with one was a false statement in an
honesty channel (§3.6), and that is what mattered most.

## What is still open

**1. The bound is sized for a constraint only one transport has.** 45 KB comes from the MCP harness
ceiling. On the CLI, `batch … --return all` over three producers can cross it (each section is
already bounded at `RENDER_CHAR_CAP` = 20 000 chars) and lose whole sections for a limit that is not
its own. Not a lie — the marker fires and names the remedy — but it is the surface most likely to
run a wide audit being trimmed by another surface's number.

The counter-argument, which is why this is not simply "raise it": an agent reads CLI stdout through
a tool wrapper that has its OWN ceiling. Lifting the CLI to unbounded trades codemaster's explicit,
remedy-carrying marker for an opaque cut made elsewhere. Any fix must decide whose ceiling is being
respected — a design call, not a constant change. If taken: `joinSectionsCapped(sections, budget?)`
with the current constant as the default, and a large-but-FINITE CLI budget (never `Infinity`, or
the marker stops meaning anything).

**2. `cappedJsonEnvelope`'s hint still attributes to the harness** (`src/common/truncate/cap-response.ts`):
`"response exceeded the harness size ceiling"`. It is correct at the MCP seam, which is its main
caller — but `sectionBody` (`src/mcp/render-response.ts`) also reaches it for an over-budget
`format:'json'` batch section, and that path serves the CLI too. Same misattribution as the section
marker had, one layer down. `CAPPED_MARKER` in the same file is MCP-seam-only and correct as is.
