---
id: t-000081
title: "importers_of` SUBTREE mode: an unresolvable ALIAS spec under the tree is not flagged"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: multi-program
created: '2026-07-08T00:01:20.000Z'
---
**`importers_of` SUBTREE mode: an unresolvable ALIAS spec under the tree is not flagged** — the
subtree `unconfirmed` flag (an unresolvable spec lexically under the folder, e.g. a `.scss`) only
lexically expands RELATIVE (`./`/`../`) specs; an `@/…` alias / bare spec that FAILS resolution is
not alias-expanded, so it is neither confirmed nor flagged → silently absent from `unconfirmed`.
Safe direction (UNDER-report of an unresolvable alias, never a raw-string false-LIVE), but a named
gap. Fix: lexically expand tsconfig `paths`/`baseUrl` for the unresolved-spec flag too.
`bug`·`low`·`cx:M`
