---
id: t-960572
title: 'list_symbols: add a name/fuzzy filter (`query` arg) — reuse the syntactic createPatternMatcher so a multi-thousand-name catalogue narrows by NAME, not just path/kind (OOM-safe)'
status: backlog
priority: medium
tags:
  - dogfood
  - ts-core
type: feat
complexity: M
area: ts-core
source: dogfood-jul
created: '2026-07-16T12:21:16.760Z'
---
**Gap (live dogfood, backoffice2 — 14 tsconfig groups, 7278 exported names).** `list_symbols` filters only by `pathInclude`/`pathExclude`, `kind`, `exportedOnly`/`all`, `limit`. There is NO way to narrow the catalogue by NAME — you cannot ask "show me every name matching `Clinic` / fuzzy `ClinRow`". On a 7k-name repo the output caps hard and the only levers are path/kind, which is a weak way to find a name family.

**Ask.** Add an optional `query` (name filter) to `list_symbols`, applied to the syntactic name catalogue BEFORE the per-group cap. Reuse the SAME `createPatternMatcher` the syntactic `search_symbol {syntactic:true}` path already uses (navto's project-agnostic matcher, §4) — it runs on the parsed name list with NO LS warm, so `list_symbols` stays on its OOM-safe no-program engine (the whole point of the op). `search_symbol {syntactic:true}` already proved this exact matcher works on this repo (`ClinRow` → the ClinicRow* family) while the default navto path OOM-crashed the daemon (t-167395).

So: `list_symbols {query:'Clinic'}` → the flat catalogue narrowed to Clinic* names, still grouped per tsconfig, still OOM-safe, still capped-with-honesty. Distinct from `search_symbol` (which returns per-site SymbolIds + warms the LS); this is a cheap name-narrow of the orientation catalogue.

Source: live dogfood 2026-07-16 on /Users/cody/Dev/backoffice2. Relates: t-143952 (the op), t-515730 (the syntactic matcher it reuses), t-167395 (why the OOM-safe path matters).
