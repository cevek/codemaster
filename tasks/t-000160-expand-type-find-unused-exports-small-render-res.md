---
id: t-000160
title: expand_type / find_unused_exports small render+resolve bugs (dogfood 2026-06-20, kitchensink)
status: in-progress
priority: medium
type: bug
complexity: M
area: correctness
source: dogfood-jul
created: '2026-07-08T00:02:39.000Z'
---
**expand_type / find_unused_exports small render+resolve bugs (dogfood 2026-06-20, kitchensink)**
— (a) FIXED + (b) FIXED + (c) test-landed/fix-in-addressing-track; (d)/(e) OPEN. (a) `expand_type`
on a fn/namespace merge truncated the return type after the colon — now the callable headline is
cut at the first `(` and the full call shape lives in `signatures` (NoTruncation), so nothing is
lost. (b) overload signatures were dropped everywhere — `expand_type` now lists EVERY call
signature via `getSignaturesOfType(…, Call)` in `signatures[]`. (c) `expand_type` by `name`+`file`
fails to resolve a type alias that `file`+`line`+`col` resolves (the `name`+`file` resolver path
silently ignores `file` and falls into workspace-wide fuzzy navto, where case-insensitive `span`
matches bury the exact `Span` past the cap) — FIXED by the addressing track's `name`+`file` →
`resolveNameInFile` branch in the shared `plugins/ts/resolve-target.ts`; oracle test
`test/differential/expand-type.test.ts` "Bug C". (d) `find_unused_exports` `undiscoveredPrograms`
lists ABSOLUTE paths while every other path is repo-relative; (e) namespace-merge members flagged
`inherited=true` (per the different-decl-node rule, misleading for a fn/namespace merge). (d)/(e)
are honesty/clarity. `bug`·`med`·`cx:M`

---
**Dogfood-jul cross-ref (2026-07):** this (c) shared-resolver fix is the home for the bare-name
resolution-inconsistency family reported across ops: `expand_type {name:'Node'}` flat-missing an
exported interface (entry 7), `construction_sites {name:'Node'}` "no symbol" on an ambiguous type
(entry 11), `source {name:'Backlog'}` missing an exported type search_symbol finds (entry 26). Re-probed
on current `main` 2026-07-08: `expand_type`/`source`/`find_usages` on an ambiguous name now return the
**candidate declaration list** (not a flat "no symbol"), and `construction_sites {name:'Plugin'}`
resolves the interface — so the family is largely closed. Residual UNVERIFIED, re-check per-op: the
UNIQUE-exported-but-flat-missed case (entry 26 `source{Backlog}`), which the resolve-target.ts navto
path may still bury under case-insensitive matches; distinct from the member-by-name-without-file gap
tracked in t-000095.
