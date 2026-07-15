---
id: t-673978
title: find_definition returns a confident single result without the undiscovered-nested-program disclosure that find_usages/search_symbol carry — a same-named symbol in an unindexed tsconfig yields a possibly-WRONG definition with no honesty note
status: backlog
priority: high
tags:
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-15T11:30:27.722Z'
---
**Repro (current main, hermetic).** Root tsconfig `include:["src"]`; `src/core.ts` exports `interface EditOps { fromCore }`. A nested, non-referenced `web/tsconfig.json` (`include:["."]`) has a DISTINCT `web/types.ts` `export interface EditOps { fromWeb }`.

- `find_definition {name:'EditOps'}` → returns ONLY `ts:EditOps@src/core.ts:1:18` with NO note. Silent, confident, single — and it may be the wrong target for an agent working the web/ layer.
- `find_usages {name:'EditOps'}` on the SAME repo DOES disclose: `!! LOWER BOUND — 1 repo tsconfig(s) NOT loaded (web/tsconfig.json)`.

So the honesty note exists on find_usages/search_symbol (0-match hint is t-285813, DONE) but find_definition, when it DOES resolve a single decl, omits the undiscovered-nested-program disclosure. §3.6 violation: a possibly-wrong single definition presented as certain.

**Ask.** When an unloaded nested/undiscovered tsconfig exists in the tree, find_definition must append the same LOWER-BOUND / "a distinct same-named symbol may live in unindexed <config>" note it already computes for find_usages — never a bare confident single. Distinct from t-285813 (that was the 0-MATCH hint; this is the non-empty confidently-wrong case).

Inbox source: 2026-07-10 (lines 185/190). Related: t-000073 (sibling discovery), t-285813.
