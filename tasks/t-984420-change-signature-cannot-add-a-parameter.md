---
id: t-984420
title: change_signature cannot ADD a parameter — the signature change with the largest blast radius is the one the op does not cover, and tsc catches it only for positional call sites
status: backlog
priority: medium
tags:
  - dogfood
  - ts-refactor
type: feat
complexity: M
area: ts-refactor
source: dogfood-inbox-aug
relates:
  - t-359677
audience: external
evidence: reported
created: '2026-08-08T12:05:38.852Z'
---
## What is missing

`change_signature` covers removing and reordering parameters. Adding one is not covered — and adding a
required parameter is the signature change with the real blast radius, since every call site must be
rewritten with a value chosen per site.

The compiler is a partial oracle here, not a substitute: it flags positional call sites, and stays quiet
where a call goes through a wrapper or where a default absorbs the missing argument. That is exactly the
residue a symbol-anchored, LS-driven rewrite is for.

## Свидетельство

2026-08-05, `amiro/forms-authz-destructive`. `isSelfLockoutCell` went from 3 parameters to 5, done BY HAND
because the op does not cover it. The reporter's own note on the risk: tsc caught the call sites there only
because they pass positionally, and a call site behind a wrapper or a default would not have been caught.
