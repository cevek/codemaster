---
id: t-648252
title: 'The programs: read-path lever does not reach the ambiguity resolve — an undiscovered member config still cannot prove an alias collapse'
status: backlog
priority: medium
tags:
  - dogfood
type: bug
complexity: S
area: multi-program
source: dogfood-jul
relates:
  - t-000524
surface:
  - plugins/ts
audience: external
evidence: measured
created: '2026-07-30T12:08:52.071Z'
---
`programs:` is documented (ARCHITECTURE §5-L2) as the read-path lever that recovers completeness over
an UNDISCOVERED nested config without editing the repo. It does not reach the name→declaration
resolve.

Measured: on a fixture whose member config is undiscovered (no `package.json`, not adjacent, not in
`references`), `find_usages {name:'useX'}` answers `'useX' is ambiguous — shown 3 of 3` IDENTICALLY
with and without `programs:['apps/emr/tsconfig.json']`.

Structural cause: the alias-collapse re-ask reads the BUILT set (`resolutionPrograms` over `built()`),
which deliberately excludes `programs:`-loaded explicit programs so a read-time load can never
perturb a later mutation's edit set or the §2.8 gate — a write-grade determinism constraint that also
binds reads, because `distinctDeclarations` is the shared resolve chokepoint for reads AND writes
(`resolve-target.ts` `resolveByName` serves both, `resolveForWrite` funnels through the same
`resolveTarget`).

No lie: the answer stays honestly ambiguous. But the documented remedy silently does not apply here,
which is its own §3.6 problem — an agent follows the lever and sees no change with no explanation.

Real fix is a read/write split of the resolve path, so a read may admit explicit + file-driven
programs while writes keep the deterministic built-only set. Until then the lever's scope should at
least be stated where it is advertised.
