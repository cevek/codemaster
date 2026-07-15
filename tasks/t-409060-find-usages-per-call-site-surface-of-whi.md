---
id: t-409060
title: 'find_usages: per-call-site surface of which destructured properties each site consumes (const {a,b}=fn()) — triage return-shape blast radius without N follow-up reads'
status: backlog
priority: medium
tags:
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-15T11:32:22.847Z'
---
When changing a function's return-object shape (e.g. `launchAppBrowser: { browser, context, page }`), the question at each usage is "which of these properties does THIS site destructure?" — a site using only `{browser,page}` is unaffected by a change to how `context` is produced; one using `context` may break. find_usages gives the enclosing decl + ref span, but the caller must open every call site to read the destructuring pattern.

**Ask.** A per-usage annotation like `destructures:{browser,page}` for `const {…}=fn()` sites (or a filter role `destructure-uses:context`) so return-shape blast radius is triageable in one call. Concretely useful in the reporting session: 10 call sites, all turned out to use only `{browser,page}`, learned only by grepping each.

Note the inverse — member_usages (t-000175, DONE) — resolves sites of ONE named member of a TYPE; this asks the complementary per-CALL-SITE view of what a function-RESULT destructures. Distinct.

Inbox source: 2026-07-12 (line 246).
