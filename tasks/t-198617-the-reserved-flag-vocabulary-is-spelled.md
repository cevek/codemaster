---
id: t-198617
title: The reserved-flag VOCABULARY is spelled three times (opToolSchema, cli/op-command, cli/compose) — a flag or enum value added to the MCP schema is silently rejected by the CLI; `--debug` is already missing there
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T12:36:40.062Z'
---
Op ARGS have one gate (the op's `argsSchema`, §7) and the batch ENVELOPE has one gate
(`batchToolSchema`) — both surfaces share them. The reserved request/flag vocabulary does not:

- `OP_TOOL_RESERVED_KEYS` + `opToolSchema` (`src/mcp/op-tools.ts`, `src/mcp/schema.ts`) — the MCP
  spelling, covered by an anti-drift test;
- `OP_FLAGS` (`src/cli/op-command.ts`) + the `enumFlag` literal tuples `['terse','normal','full']`
  / `['text','json']` / `['sql','all']` — the CLI spelling of the same vocabulary;
- `BATCH_VALUE_FLAGS` + `CONFLICT_KEYS` (`src/cli/compose.ts`) — the batch spelling.

No divergence today; the tuples match. The drift direction is one-way and quiet: add a fourth
`verbosity` value or a new reserved flag to the zod schema and the MCP surface accepts it while the
CLI answers `unrecognized flag(s)` — a §3.6 message that is true about the CLI's table and false
about the tool, which is the exact class this CLI just finished fixing.

**Already present, one instance:** `debug` (§13 per-call inline trace) is a reserved key on the MCP
side and has no CLI flag at all. That is a hole precisely where it costs most — the debug trailer
exists for the agent building codemaster, and that agent's loop is CLI-driven.

Cheap half: derive/share the enum tuples (and `CONFLICT_KEYS` from `batchToolSchema.shape` minus
`requests`) so the two spellings cannot disagree; add `--debug`.

Full delegation of `parseOpCommand` to `buildPerOpRequest` (whose return shape already matches) is
possible but would cost the pointed per-flag messages (`--format must be 'text' or 'json'`) that §7
treats as the product — reconsider only if the vocabulary grows again. argv hygiene (splice / stray
/ missing-value) stays CLI-local either way.
