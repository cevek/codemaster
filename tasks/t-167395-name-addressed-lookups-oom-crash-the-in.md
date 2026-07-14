---
id: t-167395
title: Name-addressed lookups OOM-crash the in-process daemon on large monorepos
status: backlog
priority: high
depends_on:
  - t-000052
tags:
  - dogfood
  - multi-program
  - platform
type: bug
complexity: L
area: platform
source: dogfood-jul
created: '2026-07-14T10:18:04.686Z'
---
## Symptom
Over MCP: `search_symbol {name:"VirtualSetup"}` on `/Users/cody/Dev/backoffice2` → `MCP error -32000: Connection closed`. The shared singleton daemon crashes, taking every warm repo down with it.

## Root cause (confirmed, current main)
`plugins/ts/search.ts::searchSymbols()` loops `host.programs()` and calls `getProgram()`+`getNavigateToItems()` on EVERY loaded program → forces all sibling/member programs to build in one heap. backoffice2: 6082 ts/tsx, root `tsconfig.json` has NO `include`/`references` → primary globs whole repo; +~13 members × (tsconfig + tsconfig.test) → ~25 programs. Peak ~6.1 GB / ~40 s; default heap 4144 MB → hard V8 OOM. `isolation=in-process` → OOM kills the daemon (uncatchable in-process). Spec §1 violation.

## Investigation (2026-07-14): the safe fix is program-pruning for DISCOVERY, NOT a syntactic navto replacement

### Fix A (SAFE, recommended) — skip file-covered programs for discovery
Primary-only navto returns the IDENTICAL full result at **0.95 GB / 4 s** vs 6.1 GB / 40 s (backoffice2, measured). The 24 member/test programs contribute ZERO new symbols because the loose root primary subsumes their files. Discovery is resolution-independent (a file's named declarations come from parse+bind of that file; `paths`/`baseUrl` don't change what's declared), so "skip building a program whose file-set ⊆ already-built" is provably complete for navto. Scope to `search_symbol` + exact-name resolve path. On a proper references monorepo Fix A prunes little (root doesn't subsume members) — but then the primary is small anyway; the genuinely-heavy case falls to the backstop below.

### NOT SAFE: extend the skip to find_usages / references
References need the program that RESOLVES an alias (`import {S} from '@x/foo'`). Root `paths:{}`; members define their own (`packages/common`→`clients/*`). A member whose files ⊆ primary still provides unique RESOLUTION → pruning it drops cross-package refs = §3.4 lie. find_usages fan-out stays heavy → backstop case.

### REJECTED (with proof): replace navto with a syntactic symbol index
Investigated deeply (2 repos, ~30 queries, `getNamedDeclarations` + `ts.createPatternMatcher` reused from a bundled TS — both project-agnostic pure fns; TS 6.0.3 vs 5.6.3 give identical matches).
- The MATCHER is NOT the blocker: reusing `createPatternMatcher` gives 100% recall (0 misses vs navto). The `VIRTUAL_SETUP`/`VirtualSetup` word-boundary case is handled.
- The BLOCKER is navto's include/DEDUP, which is SYMBOL-IDENTITY (checker) based, NOT syntactic. navto keeps an import-alias site iff the name has no in-repo definition (external lib symbol), and dedups a local name's imports to its definition.
- A syntactic RAW scan is a reliable superset OF NAVTO FOR SOURCE UNDER THE GIT ROOT (MISSraw≈0 both repos; a tsconfig include/reference reaching OUTSIDE the root is git-invisible at the root → out of scope, disclosed, not silently missed — BLOCK 1 in t-515730) but ~2× (import re-mentions) → floods the result cap, burying real defs.
- A name-based dedup ("drop imports of names that have an in-repo real decl") is PERFECT on codemaster (local-heavy: miss=0/extra=1) but MISSES 1511 on backoffice2 (`Option` 346, `Form` 338, `Modal` 176, `Button` 135…) — because common names are BOTH local decls AND library imports (`@mui` `Button` ≠ local `Button`); only resolution tells the two symbols apart. No name-based syntactic rule can reproduce navto. Conclusion: keep navto for discovery; make it cheap via Fix A, don't replace it.

### Clean use of the syntactic index: the exact-name RESOLVE path
`resolveByName`/`resolveAllByName`/rebind (resolve-target.ts:148/188/265) filter `searchSymbols` to `m.name===name` and re-resolve position via LS. Replace their navto call with an exact-name syntactic locate over tracked files (no program build), then build ONLY the containing program (`sourceFileAcross`; primary-resident on loose-root repos → 1 program). Over-finding → honest ambiguity pick-list, not a lie. This is the "attach to a project cheaply" path and is safe (identity re-established by the LS).

## Backstop (genuinely-heavy find_usages / scope:all) — depends t-000052
process-mode isolation + per-engine `--max-old-space-size` + child-exit→`ToolFailure{oom}`. The specced cross-workspace LRU governor does NOT catch one engine blowing budget mid-op — scope as per-engine cap + child-death→ToolFailure. Longer-term for proper monorepos: project-reference REDIRECTS (§9) — independent-program loading duplicates lib/@types per program (measured: 24 members ≈ 3.6 GB even without the flat root), redirects would share it.

## Immediate stopgaps (no code)
User (in-process MCP, `mcp --in-process`): `NODE_OPTIONS=--max-old-space-size=8192` (or `--max-old-space-size` as first `args` entry). Optional `daemon.maxOldSpaceMB` → `spawn-daemon.ts` execArgv for the daemon path.

## Repro
`node src/bin.ts op search_symbol '{"name":"VirtualSetup"}' --root /Users/cody/Dev/backoffice2` → OOM exit 134; `--max-old-space-size=12000` → 78 matches. Harness (navto-vs-syntactic, both repos) in investigation notes.
