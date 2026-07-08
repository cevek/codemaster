---
id: t-155425
title: construction_sites / discrimination_sites op-notes say "primary program only" — imprecise in a no-root repo (now the deepest-enclosing member program)
status: backlog
priority: low
type: doc
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T19:41:03.502Z'
---
Doc-string accuracy from t-608842. The construction_sites and discrimination_sites op NOTES read "primary program only" — literally true for a rooted repo, but in a NO-root repo they now scan the deepest-enclosing MEMBER program (via typeAuthorityFor), consistent with their disclosed single-program/no-fan-out contract but "primary" is imprecise wording. Reword to "single (owning) program, no fan-out". fix-locus: src/ops/construction-sites.ts + src/ops/discrimination-sites.ts notes.
