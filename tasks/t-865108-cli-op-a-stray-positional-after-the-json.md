---
id: t-865108
title: 'CLI `op`: a stray positional after the JSON args is silently ignored (§3 silent-swallow, positional half)'
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-15T20:11:51.440Z'
---
**Found during dogfood (t-607963 review).** The CLI `op` path picks its JSON-args positional via `args.find(a => !a.startsWith('--'))` (`bin.ts`), so any SECOND bareword is silently dropped: `codemaster op search_symbol '{...}' EXTRA_JUNK` runs the op and ignores `EXTRA_JUNK`. t-607963 closed the `--`-prefixed-flag half of the §3 silent-swallow class; this is the positional half, left open (out of that task's stated scope).

**Ask:** reject a second positional loudly (exit 2, naming it) just like an unrecognized flag, so no CLI input is silently swallowed.
