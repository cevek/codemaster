---
id: t-500947
title: CONTRIBUTING forbids import cycles but nothing enforces it — a value-level cycle survived both eslint (no `import/no-cycle`) and tsc, and was found only by a reviewer reading the split
status: backlog
priority: medium
tags:
  - dogfood
  - platform
type: infra
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T09:24:18.862Z'
---
`CONTRIBUTING` states the rule plainly — "imports flow downward only, no cycles" — and `src/README.md`
repeats it as the layering contract. Nothing checks it.

Concretely, splitting a file to stay under the 300-line cap produced a value-level cycle
(`resolve-target` ↔ `rebind-symbol-id`). `tsc` compiles it, eslint has no `import/no-cycle` rule
configured, and `knip` does not look for cycles either. It was caught by a reviewer reading the diff — i.e.
by luck of attention, not by the gate. The fix (a leaf `resolve-contract.ts`) was trivial; the detection
was not.

This matters more than a style rule: the plugin DAG's acyclicity is enforced at RUNTIME by
`PluginRegistry` (§5-L2, tested per §16 invariant 7), so the project already treats cycles as a
correctness property in one place while leaving the module graph unchecked in every other.

Ask: enable `import/no-cycle` (or the equivalent) in the eslint config so `fix-and-check` fails on it.
Note the likely friction to decide when doing it: type-only cycles are harmless and common — configure
`allowUnsafeDynamicCyclicDependency: false` + `ignoreExternal: true` and consider whether to allow
type-only edges, rather than turning the rule on blind and drowning in pre-existing hits. Report the
baseline count first; if it is large, land the rule as a warning plus a task to burn it down.
