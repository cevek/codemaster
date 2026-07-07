---
id: t-189093
title: CLI `op` path ignores `--format json` — the flag is honored only on the MCP path
status: backlog
priority: low
tags:
  - dogfood-jul
type: bug
complexity: S
area: correctness
created: '2026-07-07T21:11:48.066Z'
---
Dogfood finding (Wave-1, Track C). The CLI one-shot `node src/bin.ts op <name> '<json>' --format json` ignores the `--format json` flag — JSON output is produced only on the MCP/daemon path. This blocks CLI-based verification of structured fields (e.g. asserting `Result.truncated` surfaces in `format:json`); tests had to assert the structured field in-process instead.

Also recorded in the codemaster feedback inbox (~/.codemaster/feedback/inbox.md). fix-locus: src/bin.ts flag handling → render path (route `--format json` to the same JSON renderer the MCP facade uses).
