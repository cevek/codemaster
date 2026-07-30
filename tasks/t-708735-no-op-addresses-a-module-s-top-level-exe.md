---
id: t-708735
title: No op addresses a module's top-level executable statements — a CLI/bin entry point is invisible to every addressing shape, so the file that decides the binary's behaviour falls out of the tool
status: backlog
priority: medium
parent: t-560034
type: feat
complexity: M
area: ts-core
source: dogfood-jul
relates:
  - t-561552
  - t-808789
surface:
  - src/ops/source.ts
  - src/ops/symbols-overview.ts
audience: external
evidence: repro
created: '2026-07-30T11:18:47.011Z'
---
## Repro (/Users/cody/Dev/agent-docs, `src/cli.ts` ~600 lines, ESM script)

The entry point is not a declaration: it is free top-level statements at the end of the module —
`const [cmd, arg] = process.argv.slice(2)` + an if/else dispatcher + `process.exit`.

Every addressing op (`source` / `find_definition` / `expand_type` / `search_symbol`) takes
`symbolId | name | file+line+col`, i.e. requires a DECLARATION. None answers "show me the module's
executable body". `symbols_overview {all:true, subgroupByKind:true}` honestly listed 113 declared names —
the dispatcher is not among them, so from the catalogue its existence is not even visible.

`source {targets:[{file:'src/cli.ts', line:590, col:1}]}` does not help either: it requires already
KNOWING the line, which is the information being sought.

Fallback: `tail -60 src/cli.ts` via Bash — falling out of the tool on exactly the region that defines the
binary's behaviour. For CLIs / scripts / bin entry points (a sizeable class of TS repos) top-level
side-effect code IS the main function; this is a typical case, not an edge.

## Ask

- `source {targets:[{file:'src/cli.ts', topLevel:true}]}` — return the module's top-level statements that
  are NOT declarations (calls, assignments, if/for, await).
- At minimum a `hasTopLevelCode` flag + line range in `symbols_overview`, so there is something to aim at.
