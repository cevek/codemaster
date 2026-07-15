---
id: t-607963
title: CLI `op` has no --format json (both spellings silently ignored) + an unrecognized CLI flag is silently dropped — blocks scripting the dogfood/self-dev loop and violates §3 (silent drop)
status: done
priority: medium
tags:
  - dogfood
type: dx
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-15T18:21:48.634Z'
---
**Two friction points on the CLI self-dev/dogfood loop (`node src/bin.ts op <name> …`):**
1. No `--format json`: both `--format json` and `--format=json` are silently ignored → CLI emits dense-text only. An agent scripting the dogfood loop cannot pull structured output (e.g. `Result.intake`) as JSON and must scrape text.
2. §3 nit: an unrecognized CLI flag is silently DROPPED rather than warned/rejected — a silent-swallow that mirrors the intake anti-pattern the tool otherwise forbids.

**Ask:** support `--format json` on the CLI `op` path (parity with the MCP `format` flag), and warn/reject unrecognized CLI flags instead of dropping them.

Source: track A codemaster feedback #2 (verified live).
