---
id: t-302965
title: 'CLI `op`: `--verbosity=full` (equals-form) is rejected as unrecognized — no parity with `--format=json`'
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-16T10:21:09.986Z'
---
**Found during t-337633/t-865108 review (verified on current main).** The CLI `op` path parses `--verbosity` via `argValue` (space-form only: `--verbosity full`), while `--format` uses `flagValue` (both `--format json` and `--format=json`). So `--verbosity=full` is NOT spliced and falls through to `unknownFlags`, which rejects it as an unrecognized flag (exit 2).

This fails **loudly** (exit 2, not a silent drop), so it is NOT a §3 honesty violation — just an ergonomic inconsistency: the equals-form works for `--format` but not `--verbosity`.

**Ask:** route `--verbosity` through `flagValue` (like `--format`) so `--verbosity=full`/`--verbosity=normal` parse, for equals-form parity across the CLI value-flags. Small, `src/bin.ts` only.
