---
id: t-871926
title: 'Session prose folding: register the remaining repeated-explanation families as lessons'
status: review
priority: medium
tags:
  - render
created_by_session: s-207994
type: imp
complexity: M
area: render
evidence: reported
author: mi-24e6dc2b
created: '2026-11-16T12:45:43.448Z'
---
The MCP facade folds a registered lesson (`common/lesson`, registry `ops/lesson-catalogue.ts`, §12 "Session prose folding") after its first full showing per session. Families NOT yet registered (static explanation still repeats verbatim in-session):

- `ops/list-inactive-hint.ts`, `ops/search-file-hint.ts` (absence hints)
- ambiguity tail of a bare-name FAIL; `plugins/ts/syntactic-decl.ts` `MERGE_CAVEAT` / `PICK_ONE` / miss prose
- `ops/guard/navigate.ts` `gives:` prose other than `SYNTACTIC_SOURCE_GIVES`, and the fan-out remedy text
- `ROW_CAP_HINT`-style `truncated.hint` strings
- mutation-gate notes (`mutation-support`, `programs-lever`), `affected` / `impact` / `impact_type_error` `!!` cap prose
- `ops/scan-coverage.ts` `emptyScanRemedy` + `!! PARTIAL SCAN` statics; `ops/trace-type-widening-scope.ts` `SKIP_CAUSE` + per-step budget note
- `ops/symbols-overview.ts` `SYNTACTIC_NOTE` head ("syntactic NAME catalogue …")

Method: extract the longest static run verbatim into a `defineLesson` (the `Result` stays byte-identical), register it, extend the MATRIX of `test/e2e/session-fold-detector.test.ts` with a call that reaches the family. Done = the detector covers each family and stays green; `test/unit/lesson-registry.test.ts` green.

## Registered in t-720126
syntactic-decl misses (decl-*), list-inactive (nested-plugin), search-file hint (file-not-symbol), affected floors (affected-*), impact timeout, programs lever (programs-*), scan-coverage empty-scan remedies (scan-nothing-ran, scan-no-source), widening skip causes, symbols_overview head (overview-catalogue). Detector MATRIX extended with syntactic `source` misses.
Left out by the plan's rule (static run < 60 chars, facts woven in): navigate `gives:` clauses, `ROW_CAP_HINT` (59), §2.8 gate notes, the short affected/impact cap clauses, `!! PARTIAL SCAN` (subject nouns interpolated), widening `deadline` cause (contained in scan-coverage `skip-deadline`).
