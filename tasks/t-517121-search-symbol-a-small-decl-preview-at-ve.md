---
id: t-517121
title: 'search_symbol: a small decl preview at verbosity:full, and a "no symbol; did you mean a file/module?" hint on a 0-match name'
status: backlog
priority: medium
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-07T20:07:32.184Z'
---
Two small `search_symbol` ergonomics (inbox 47, 373part, 401, 8, 68 — claude-ui/code-diff, 2026-07-02→07):

1. At `verbosity:'full'` it still returns only the SymbolId line (`ts:SessionManager@…:1127:14~… · class`) with no source/decl preview — a small preview would serve a direct "lookup" without a chained `source`/`find_definition`.
2. On a 0-match name that IS a known file/module (`buildView` → `apps/web/src/lib/buildView.ts` exists but its exports differ), a `no symbol; did you mean a file/module?` hint saves a fallback grep.

**Scope correction.** The earlier "return nearest fuzzy candidates (edit-distance / token-overlap)" ask is NOT kept here: on the motivating example (`UsageBar` → the real `RateLimitBar`) the only lexical overlap is the generic `Bar` token, so edit-distance never bridges it and token-overlap drags in every `*Bar` — it's a SEMANTIC guess lexical matching can't rank. The right answer to that need is the broad name-catalogue browse tool **t-143952** (`list_symbols` — dump many names, agent picks), not a "did you mean" ranking. So this task stays the two small ergonomics above; near-miss discovery lives in t-143952.
