---
id: t-070252
title: 'Role/behavior-aware symbol search: match leading JSDoc/doc-comment text (not just member name), so "which set gates rename-classification" surfaces `IDENTIFIER_TYPES`'
status: backlog
priority: low
tags:
  - dogfood-jul
type: feat
importance: low
complexity: M
area: wish
created: '2026-07-07T20:07:14.248Z'
---
Inbox entry 15 (`code-diff`), 2026-07-03. `search_symbol` is fuzzy NAME matching. Needed "the set that decides rename-vs-update in classify" — the gating const is `IDENTIFIER_TYPES` (named after its MEMBER TYPE, not its ROLE), so `search_symbol('rename'|'renameable'|'RENAME_TYPES', pathInclude:['src/classify'])` all returned 0 and grep for the literal `'type_identifier'` was the fallback. The symbol's JSDoc literally says "a relabel of one is a `rename`, not an `update`". Ask: a role/behavior-aware lookup that also matches leading doc-comment/JSDoc text and ranks by it — even a flag on `search_symbol` to include doc-comment text would close this. Behavior-gating sets named by member-kind rather than role are a common blind spot for name-only fuzzy search.
