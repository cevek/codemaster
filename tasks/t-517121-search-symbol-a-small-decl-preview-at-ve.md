---
id: t-517121
title: 'search_symbol: a small decl preview at verbosity:full, and a "no symbol; did you mean a file/module?" hint on a 0-match name'
status: backlog
priority: low
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-07T20:07:32.184Z'
---
Inbox entries 47, 373(part), 401, 8, 68 (`claude-ui`, `code-diff`), 2026-07-02→07. Two small `search_symbol` ergonomics: (1) at `verbosity:'full'` it still returns only the SymbolId line (`ts:SessionManager@…:1127:14~… · class`) with no source/decl preview — a small preview would serve direct "lookup" use without a chained `source`/`find_definition` call. (2) On a 0-match name that IS a known file/module (`buildView` → `apps/web/src/lib/buildView.ts` exists but exports differ), a `no symbol; did you mean a file/module?` hint would save a fallback grep — the sibling of the non-existent-name redirect (entry 8: on a name-miss, name `search_symbol` or return nearest fuzzy candidates rather than a dead-end FAIL).
