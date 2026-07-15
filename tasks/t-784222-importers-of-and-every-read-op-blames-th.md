---
id: t-784222
title: importers_of (and every read op) blames the arg when the PRIMARY program is absent — should report ToolFailure/unavailable, not resolved:false / 0 importers
status: done
priority: low
tags:
  - dogfood
type: bug
complexity: M
area: ts-core
source: dogfood-jul
created: '2026-07-15T20:13:25.306Z'
---
**Reproducible core.** When the PRIMARY program is DEGENERATE — a broken / empty-`include` tsconfig that resolves 0 project files — a `importers_of` module arg cannot resolve under the primary's options → `resolved:false`. The op then renders `module unresolved: X — pass a repo-relative path`, BLAMING the agent's arg form when the true cause is the empty program (§3.6 misattribution).

(The originally-filed locus `importers.ts:107` `getProgram() === undefined → resolved:false` is a DEAD defensive branch: a full-mode `ts.LanguageService.getProgram()` is never `undefined` even over 0 files — it returns an empty Program — and an actual LS build THROW is already caught by the op's try/catch → honest `ToolFailure`. It is also the ONLY data-shaped missing-primary return in the read surface, so the "general upstream gap across every read op" premise does not hold. The reproducible misattribution is the degenerate-primary resolution path above, not that branch.)

**Fix (real, closes the task).** `findImporters` flags `emptyProgram` when the primary covers 0 project files (`host.fileNames().length === 0`, already memoized). In the zero-importers branch the op prefers an honest `primary program covers no files: … this is why 'X' did not resolve, NOT the arg form. Fix the tsconfig include/config, or target a package with its own tsconfig via root:<pkg-dir>` over the arg-blame steer. A HEALTHY primary still arg-blames a genuinely unresolvable specifier (no over-trigger).

Discriminating test: `test/differential/importers-empty-primary.test.ts`.
