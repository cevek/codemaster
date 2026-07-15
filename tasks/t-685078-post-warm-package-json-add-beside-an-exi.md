---
id: t-685078
title: Post-warm package.json-add beside an existing tsconfig does not re-discover the package until the next tsconfig change / respawn (honest-stale, not a lie)
status: backlog
priority: low
tags:
  - dogfood
  - multi-program
type: bug
complexity: S
area: multi-program
source: dogfood-jul
created: '2026-07-15T20:41:17.144Z'
---
**Context.** t-865312 anchors package discovery on `package.json` presence beside a `tsconfig*.json`. The structural-reindex trigger `isStructuralConfigChange` (src/plugins/ts/ls-host.ts) fires on a `tsconfig*.json` add/remove, but deliberately EXCLUDES `package.json` from the changed set (it churns on every `npm install`). `addsMemberStray` only fires for a `.ts` file under an already-known package dir.

**Consequence.** On a WARM daemon, creating `web/package.json` beside a pre-existing `web/tsconfig.json` (turning an un-anchored nested tsconfig into a package) is NOT picked up until the next `tsconfig*.json` change or an engine respawn — `web/` stays floored.

**Honest, not a lie.** Confirmed the stale state fails HONESTLY: `find_usages` on a symbol in `web/` returns `ts-ls` + names the floored config ("NOT proof it is gone"). This is the documented conservative-staleness contract (ls-host.ts ~530: stale ⇒ larger undiscovered set ⇒ more floored, never a false-certain-dead). So it degrades to over-floor, never a §3.4/§3.6 lie.

**Fix (if pursued).** Include a `package.json` add/remove in the structural-reindex trigger's changed-set predicate ONLY when it lands beside a tsconfig (or newly creates a package dir), without re-triggering on ordinary dependency-install churn. Bounded: filter to `package.json` paths whose dir also holds a `tsconfig*.json`.

Filed per t-865312 bug-review residual note. Low priority (honest-stale; the cold path and post-tsconfig-change path are correct).
