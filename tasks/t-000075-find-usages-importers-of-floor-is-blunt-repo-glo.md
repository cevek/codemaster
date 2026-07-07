---
id: t-000075
title: find_usages` / `importers_of` floor is BLUNT (repo-global, not symbol-scoped)
status: backlog
priority: low
type: imp
complexity: M
area: multi-program
created: '2026-07-08T00:01:14.000Z'
---
**`find_usages` / `importers_of` floor is BLUNT (repo-global, not symbol-scoped)** — the floor now
SHIPS (a usage living only in an undiscovered program no longer reads as a confident-`0`:
`complete:false` + named `undiscoveredPrograms` + a `!!` LOWER-BOUND note, and fix-A's nearest-config
discovery resolves most in-app cases first). But like the `find_unused_exports` floor it demotes
`complete:false` on EVERY call when ANY undiscovered config exists, even for a symbol that config
could not reference. Symbol-module-scoped demotion (flag only when an undiscovered program plausibly
imports the symbol's module) is precise but costlier. `imp`·`low`·`cx:M`
