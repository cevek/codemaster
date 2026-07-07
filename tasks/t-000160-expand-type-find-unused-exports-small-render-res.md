---
id: t-000160
title: "expand_type / find_unused_exports small render+resolve bugs (dogfood 2026-06-20, kitchensink)"
status: backlog
priority: medium
type: bug
importance: medium
complexity: M
area: correctness
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
