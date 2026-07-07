---
id: t-310874
title: Path-filter globs mis-handle a literal dir containing glob-special chars (src/(auth), src/@scope) — no working incantation
status: done
priority: medium
depends_on:
  - t-994174
tags:
  - dogfood-jul
  - intake
created: '2026-07-07T21:13:09.008Z'
---
Surfaced by bug-review of Track A (t-994174 fix, 2026-07-08). NOT a lie — the honesty note still fires (`filteredOutByPath>0` → "NOT a symbol absence") — but a literal directory whose name contains glob-special chars has NO working path-filter incantation.

Repro: `search_symbol {query:'X', pathInclude:['src/(auth)']}` (Next.js route group) or `['src/@scope']`. `expandDirGlobs` (src/common/glob/expand-dir.ts) treats `( ) @ ! + |` as author-intended pattern chars (GLOB_META), so a bare dir containing them is NOT expanded, AND picomatch then interprets them (regex group / extglob). Verified: `picomatch.isMatch('src/(auth)/page.tsx', ['src/(auth)','src/(auth)/**'])` → false. So neither the literal entry nor an auto-expanded prefix matches — no incantation works for such a dir.

Scope: affects EVERY matchesAnyGlob path filter (search_symbol, list, find_usages.filter, construction_sites, find_unused_exports) — pre-existing class, not just the new expand.

Fix direction (needs care — match.ts's rule is "do NOT hand-roll glob semantics"): when an entry resolves to an existing directory (ts.sys.directoryExists) OR contains only ambiguous meta chars (`()@!+|` but none of `*?[]{}`), picomatch-escape it before both the literal match and the `/**` expansion. Prefer a vetted escape util over hand-rolled. The `search_symbol` miss-note already hints "glob-special chars like ()@! may need escaping" as an interim actionable signal.
