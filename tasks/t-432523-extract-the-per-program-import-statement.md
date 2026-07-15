---
id: t-432523
title: Extract the per-program import-statement scan scaffold shared by importers.ts / importers-subtree.ts / phantom-imports.ts (n=3, rule-of-three)
status: backlog
priority: low
tags:
  - dogfood
  - multi-program
  - refactor
type: imp
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-15T21:13:36.835Z'
---
**Duplication (copy-paste review, t-272300).** Three files in `plugins/ts/` run a byte-near-identical per-program import-statement scan scaffold:
- `src/plugins/ts/importers.ts:122-140`
- `src/plugins/ts/importers-subtree.ts:42-58`
- `src/plugins/ts/phantom-imports.ts:48-77` (added by t-272300 — took it n=2 → n=3, crossing rule-of-three)

The scaffold: `for (const p of host.programs())` → `getProgram()` guard → `getCompilerOptions()` → per-program `new Map<string,string|undefined>()` resolve-cache → `for sourceFile of program.getSourceFiles()` → skip `/node_modules/` → `for stmt of sourceFile.statements` → `moduleSpecifierOf(stmt)` → `resolveSpecifier(spec, sourceFile.fileName, options, cache)` → `getLineAndCharacterOfPosition`. The leaf helpers (`moduleSpecifierOf`, `resolveSpecifier`) are already shared; the LOOP scaffolding is the duplicated unit.

**Ask.** Extract a shared statement-iterator in `plugins/ts/` (e.g. `import-scan.ts` — `forEachImportStatement(host, cb)` yielding `{ sourceFile, stmt, spec, resolve(): string|undefined, lc, importerRel }`), and migrate all three callers to keep only their own filter+emit body (phantom: node_modules gate + row; importers: `matches()`; subtree: prefix containment).

**CAVEAT — dedup-key divergence (MUST preserve on extraction).** The three callers key their cross-program seen-set differently:
- `phantom-imports.ts:62` keys `file:line:COL` (needs col granularity — two bare imports on one physical line, `import a from 'x'; import b from 'y';`, are distinct phantom sites and must both survive / both count toward `importSiteCount`).
- `importers.ts:134` and `importers-subtree.ts:55` key `file:line` only.

A shared iterator MUST key at COL granularity (or expose the key granularity per-caller), else phantom's `importSiteCount` silently undercounts. (Whether importers' line-only key is itself a latent undercount is a separate correctness question for a bug-review of track G.)

**Boundary note.** `importers.ts` + `importers-subtree.ts` are track-G engine files; `project-files.ts` (`programFileGroups`) is a DELIBERATELY separate primary-first FILE-dedup (documented at `importers.ts:114-121`) and must NOT be folded in. Best done by / coordinated with the importers/find-usages owner.
