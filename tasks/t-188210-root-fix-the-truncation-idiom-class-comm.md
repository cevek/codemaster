---
id: t-188210
title: 'Root-fix the truncation-idiom class: common/truncate/ chokepoint + CapId registry + ESLint guard'
status: backlog
priority: medium
tags:
  - copy-paste
  - dogfood
  - platform
type: imp
complexity: L
area: render
source: dogfood-jul
created: '2026-07-14T16:22:40.766Z'
---
## Why (the recurring class the user named)
We keep fixing ONE manifestation of output-truncation at a time (t-481241 = expand_type signature elision was the 3rd). A 3-agent read-only class-audit (jul-14) found the root: **there is no single truncation chokepoint** — the same intents are re-spelled inline at ~30 sites, so a fix to one wording never reaches its siblings. The `Truncation` TYPE exists (`core/result.ts:54-60`) but nothing forces a truncation site to PRODUCE one; the string-elision family produces no honest marker beyond a bare `…`. Doctrine (CLAUDE.md anti-patterns): a recurring class = a wrong default → fix at the ROOT (invert default) + add a COMPILE/LOUD guard so it cannot silently reappear.

## Audit inventory (proof-carrying; nothing lost)

### CLASS-A — type/signature-string caps (6 sites, UNIFORM defect: not-verbosity-aware + no-hint + no-total) — the actual recurring bug
1-2. `plugins/ts/type-expand.ts:160/300` (MEMBER_TYPE_CAP=200) — **FIXED by t-481241** (verbosity-aware + §3.4 hint w/ length).
3. `plugins/ts/type-widening.ts:274` (TYPE_CAP=200) → trace_type_widening.
4. `plugins/ts/overlay-type.ts:169` (TYPE_CAP=200) → impact_type_error.
5. `plugins/ts/first-param-members.ts:167` (MEMBER_TYPE_CAP=200) → find_unused_props / trace_prop_through_tree.
6. `plugins/ts/member-usages.ts:221` (TYPE_NAME_CAP=120, bare `…` no marker word) → member_usages — WORST (diverges on cap value AND marker). NB t-487095 EXCLUDES it from the *elide* consolidation (it is a short type-NAME hint, different contract) — but it still deserves a marker.

### CLASS-B — result-set / list caps — framework OVERWHELMINGLY SOUND (no silent-slice found)
Nearly every row/site/scan cap rides canonical `{shown,total,hint}` with PRE-slice totals; `RENDER_CHAR_CAP=20_000` backstop cuts only re-fetchable bulk behind `!! OUTPUT CAPPED` and reserves honesty channels. Two residuals only:
- **Genuine non-conformance:** `ops/importers-of.ts:149-150` slices `internal` + `unconfirmed` arrays with only sibling `*Count` fields; the `Truncation` envelope points ONLY at `external` → [no-total][no-hint] at array level. Filed as its own child.
- **Honest-but-non-canonical (lower priority, NOT lies):** nested-depth member overflow in expand_type → soft `notes` not Truncation (single-channel limitation, `type-expand.ts:194-197`); graph-closure caps (`impact`/`affected`/`trace_*`) report via `!!`-note + boolean rather than `{shown,total,hint}`. Consider normalizing later.

### Duplication families (why it recurs)
- Family-1 scalar elide `slice+…`: ~12 copies, 3 spellings (incl. the 6 above + bare-`…` at member-usages:221, jsx-child-sites:188, condense:69, render-source:98).
- Family-2 "name K then +N more": **6 byte-identical copies** — `ops/no-symbol-hint.ts:25`, `find-unused-exports.ts:55`, `find-usages-view.ts:138`, `importers-of.ts:23/177`, `unused-exports-classify.ts:133`. Clearest copy-paste.
- Family-3 list-cap → {shown,total,hint}: half-centralized (`render-result.ts:147 renderTruncation`, `list.ts:45 combineTruncation`) + many bare `.slice(0,limit)` where the marker is assembled elsewhere (silent-drop risk).

## Root-fix design (from the audit — split by concern, do NOT conflate)
**`src/common/truncate/`** (layering-legal: common/ imports only core/, and `Truncation` lives in core/):
1. `elide-string.ts` → `elideString(s, cap, verbosity): {text, elided}` — single owner of `slice+…`; carries the `elided` flag `spans.ts:37` already models. Family-1 routes here.
2. `cap-list.ts` → `capList<T>(items, cap, hint): {shown, truncation?}` returning the core `Truncation` AT THE CUT — subsumes `combineTruncation`; forces every display-list `.slice` to co-produce its envelope. Family-3 routes here.
3. `name-with-more.ts` → `nameWithMore(labels, k)` — Family-2's 6 copies collapse to one call.
Thread `Verbosity` so `full` lifts the cap by construction (this is exactly what t-481241 did locally; the chokepoint makes it universal).

## Guard (honest about the precedent — FULL_DISPOSITION only HALF-transfers: rendering had a single funnel `condense`, truncation has none — that absence IS the root cause)
1. Build the chokepoint first.
2. **ESLint `no-restricted-syntax` (LOUD)** — ban, outside `common/truncate/`: `slice(` inside a `…`-template, the `x.length>CAP ? … : x` ternary, the `+${n} more` literal. Message: "route through common/truncate". Fails `fix-and-check`/CI loudly. This is the realistic mirror.
3. **`Record<CapId, CapDescriptor>` registry** (the GENUINE compile mirror): every scattered cap constant becomes a `CapId`; `CAP_DESCRIPTORS: Record<CapId,{value,label,hint,verbosity}>` exhaustive → a new `CapId` with no descriptor = COMPILE error. `elideString`/`capList` take a `CapId`, not a raw number, so marker + verbosity attach by construction.

## Suggested build order (decompose into children when picked up)
(1) `common/truncate/` three functions + `CapId` registry; (2) migrate CLASS-A 6 sites (child t-487095, member-usages marker included); (3) migrate Family-2 6 copies; (4) fix importers-of:149-150 (child); (5) ESLint guard. Optionally (6) normalize the honest-non-canonical caps (impact/affected/trace_*, nested-member) onto Truncation.

## Manifestations / relations
- t-481241 (DONE) — CLASS-A #1/#2, the first landed slice (verbosity-aware + hint).
- t-487095 — CLASS-A migration of the remaining 4 sites (child); align its helper home with `common/truncate/` here rather than a ts-local helper, so Families 2/3 reuse it.
- t-262394 — separate (checker structural-inline behavior, NOT truncation).
