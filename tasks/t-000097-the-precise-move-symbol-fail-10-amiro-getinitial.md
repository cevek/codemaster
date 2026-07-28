---
id: t-000097
title: '**the precise move_symbol fail[10] (amiro `getInitials`→`src/lib/utils.ts`, "edits target'
status: backlog
priority: medium
type: bug
complexity: M
area: ts-refactor
relates:
  - t-000096
  - t-642069
surface:
  - plugins/ts
audience: external
evidence: measured
created: '2026-07-08T00:01:36.000Z'
---
**the precise move_symbol fail[10] (amiro `getInitials`→`src/lib/utils.ts`, "edits target an unknown
file …/PersonAvatar.tsx") has no captured repro** — the observed desync was on the SOURCE-side
`PersonAvatar.tsx` (not a gitignored importer like the floor repro above), pointing at a different
trigger: a realpath↔git path-form skew, a nested-path mismatch, or a DUPLICATE `getInitials`
(cf. fail[9]) resolving the symbol into the wrong file. The amiro snapshot is destroyed, so a
faithful repro needs real amiro inputs; the honest refusal + zero-write floor holds regardless.
Reproduce against a path-form / duplicate-symbol fixture, then close the matching desync.
(2026-06-23: 4 hermetic sandbox repros on current main — duplicate-symbol, alias-vs-relative
importer, APFS case-variant import, nested-dir + re-export barrel — all NO-REPRO; apply succeeded,
the floor held. Likely already fixed; reopen only with captured amiro inputs.) `bug`·`med`·`cx:M`
