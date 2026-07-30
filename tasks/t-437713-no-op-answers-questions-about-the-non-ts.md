---
id: t-437713
title: 'EPIC: the non-TS config / dependency graph has no home — four agents in four repos fell back to grep on the same class'
status: backlog
priority: medium
type: feat
complexity: L
area: platform
source: dogfood-jul
relates:
  - t-120055
  - t-810757
  - t-815425
audience: external
evidence: reported
created: '2026-07-30T11:18:46.574Z'
---
## One class, four repos, four filings

`/Users/cody/Dev/task-manager`, `/Users/cody/Dev/amiro`, `/Users/cody/Dev/code-diff`, and the
agent-docs run all hit it, all on the same shape of task: retire / rename / add a TOOL. The nodes are not
TS symbols, so no op reaches them, while the repo instruction says "default to codemaster for anything
reference-graph-shaped".

Concrete task, three times: remove `lint-staged`. Its whole footprint is `package.json` (a config block +
a devDependency), `.husky/pre-commit`, and prose in `CONTRIBUTING.md` / `ARCHITECTURE.md`.
`find_usages` / `importers_of` / `impact` are symbol- or module-addressed; a devDependency that is never
`import`ed is invisible to all of them. `find_phantom_deps` answers the INVERSE (imported but undeclared).

## Why it is not merely "out of scope"

The fallback is silent-miss-prone in exactly the way the spec warns about for symbols: a tool is spelled
`lint-staged` in package.json, `lintstaged` in a script, `npx lint-staged` in a hook. And one measured
near-miss shows the cost: in amiro, `npm run format` was src-only while lint-staged covered the repo, so
dropping lint-staged would have silently stopped formatting `scripts/`, `tests/`, `dev-recorder/` and root
configs — a coverage regression with NO failing gate. Caught only by hand-diffing two globs.

## Shapes asked for (any subset is progress)

- `dependency_refs {name}` — every declaration site (deps/devDeps, a config block keyed by the tool
  name, workspace package.jsons), every TS import, every mention in scripts / hook files / CI workflows /
  ignore files, plus prose mentions in tracked `.md` flagged separately as unverified text.
- `script_usages` / extend `find_usages` to accept `npm:<script>` and `bin:<name>` targets.
- `glob_coverage {globs:[…], against:'tracked'}` — matched/unmatched file ROWS, so `sql` can anti-join two
  config globs ("what did glob A cover that B does not?"). This is the generic shape behind replacing one
  tool's file selection with another's.
- `find_unused_config` — package.json top-level blocks and devDeps whose only invoker is a shell/hook file
  (knip does the devDep half, and knows nothing about `.husky/`).

## The zero-cost half, worth doing first

Say the boundary OUT LOUD in `status`'s concepts: a "does this task have a symbol question at all?"
framing. Today an agent burns calls discovering that the answer is no — one reporter noted that
`symbols_overview` was called on a config-only change purely to satisfy the instruction. codemaster's
differentiator here is that `sql` + proof-spans already exist; what is missing is any producer emitting
non-TS rows.
