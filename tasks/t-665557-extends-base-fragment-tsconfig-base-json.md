---
id: t-665557
title: extends-base fragment (tsconfig.base.json) over-demotes the floor — needs a paths/baseUrl-guarded subtraction (deferred from t-816306 part 2)
status: done
priority: low
type: imp
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T12:47:46.368Z'
---
Deferred part 2 of t-816306. A shared extends-base fragment (tsconfig.base.json — no own include/files) stays in the undiscovered floor because it default-globs the whole repo incl strays → not covered → floored. That's an OVER-demotion (base owns no unique searchable surface), NOT a lie. A safe subtraction = subtract an extends-target fragment iff it declares no own include/files/references AND declares no paths/baseUrl (an un-gated subtraction would lie: a fragment WITH paths + a root-level alias file covered only by the fallback → complete:true while its alias-usage is unresolved/missed). No-op on claude-ui (its base has no paths); only helps clean base-monorepos with no strays. Low.
