---
id: t-713862
title: 'CLI: `--root <dir>` placed BEFORE the `op <name>` subcommand prints usage instead of parsing the flag'
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-15T18:24:12.303Z'
---
**Repro (current main).** `node src/bin.ts --root <dir> op <name> '<json>'` prints usage instead of running the op — the global `--root` flag is only accepted AFTER the subcommand. Standard CLI convention accepts a global flag on either side of the subcommand.

**Ask:** accept `--root` (and other global flags) before the `op` subcommand too. Same CLI-seam robustness class as t-607963 (CLI `--format json` / silent unrecognized-flag drop) — could be fixed together.

Source: track B codemaster feedback (friction, verified live). Related: t-607963.
