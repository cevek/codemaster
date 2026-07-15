---
id: t-773499
title: find_definition-by-name + rename_symbol FAIL "Could not find source file" on any NON-PRIMARY program (workspace member OR isolated package)
status: backlog
priority: low
tags:
  - dogfood
  - multi-program
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-15T20:14:09.048Z'
---
**Pre-existing** (reproduces on `main` for a workspace MEMBER, independent of t-865312 — confirmed by stashing the t-865312 change and re-running).

**Repro (hermetic).** A repo with a subdir program that is NOT the primary (a pnpm workspace member `packages/ui`, or — post t-865312 — an isolated nested package `web/`):
- `find_usages{name:X, file:'<subdir>/...'}` → WORKS (fans out via `programsContaining`/`findReferencesAcross`).
- `find_definition{name:X}` (and with a `file:` pin) → FAIL `ts-ls` "Could not find source file: '<abs path in subdir>'".
- `rename_symbol{name:X, file:'<subdir>/...', newName:Y}` → same FAIL.

So `find_usages`/`search_symbol` correctly reach non-primary programs, but the definition/rename path resolves the symbol's file and then calls an LS (the primary) whose program does not contain it → the TS LS throws "Could not find source file". It is caught and surfaced as an honest `ToolFailure` (daemon survives, agent falls back) — NOT a silent wrong edit — but the op is unusable for every symbol whose declaration lives outside the primary program.

**Likely fix locus.** The by-name / file-pinned resolution in the definition + rename paths must pick the program that actually CONTAINS the declaration file (`builtContaining(absPosix)` / `sourceFileAcross`), the same way `find_usages` does, before calling `getDefinitionAtPosition` / computing rename sites — instead of anchoring on the primary. Touches `ops/find-definition.ts` and/or the ts-plugin definition/rename seams (`plugins/ts/*`), plus the rename cross-program program-selection.

**Impact.** With t-865312 auto-indexing isolated packages, this now bites the entire frontend of a nested-package repo for definition/rename (find_usages/search work). Parity with the pre-existing member limitation — but that limitation is now much more reachable.

Boundary note: outside Track F (program discovery). Owner of `ops/find-definition.ts` run-body + rename cross-program selection.
