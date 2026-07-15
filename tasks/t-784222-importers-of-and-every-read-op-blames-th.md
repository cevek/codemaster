---
id: t-784222
title: importers_of (and every read op) blames the arg when the PRIMARY program is absent — should report ToolFailure/unavailable, not resolved:false / 0 importers
status: backlog
priority: low
tags:
  - dogfood
type: bug
complexity: M
area: ts-core
source: dogfood-jul
created: '2026-07-15T20:13:25.306Z'
---
**Surfaced by:** track G bug-review of t-135997. `src/plugins/ts/importers.ts:107` `findImporters` early-returns `{resolved:false, importers:[], total:0}` when `host.service.getProgram() === undefined` (no primary program — a missing/broken tsconfig or an LS build failure). The op then renders the `module unresolved: X — pass a repo-relative path` steer, BLAMING the agent's arg when the true cause is "no program at all".

**Not a regression** (the pre-t-135997 note `'no importers found — check the specifier … against tsconfig'` already misattributed in this same state), and NOT importers_of-specific: any read op that reads `getProgram()` and finds it undefined has the same gap. Leaving `resolved:false` is the lesser evil (it never claims a false resolved-TRUE), so track G defers rather than papering it with a worse `resolved:true`.

**Honest fix (general, upstream of the importers_of diff):** when the PRIMARY program cannot be built, read ops should return a `ToolFailure` (`ts-ls` / plugin-unavailable — "no TypeScript program; check tsconfig") with empty data (§3.6 / CONTRIBUTING resilience), never a data-shaped answer that attributes the failure to the agent's input. Applies across the read-op surface; scope as a shared plugin-level guard, not a per-op patch.

Source: track G (t-135997) bug-reviewer residual.
