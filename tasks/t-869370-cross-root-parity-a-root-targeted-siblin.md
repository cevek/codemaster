---
id: t-869370
title: 'Cross-root parity: a root:-targeted sibling repo loads ITS OWN tsconfigs (t-000073 ask 3)'
status: backlog
priority: medium
depends_on:
  - t-000073
type: imp
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T09:11:26.417Z'
---
Ask 3 of t-000073. A 'root:'-targeted sibling repo does NOT load that repo's own tsconfigs, so every cross-root importers_of/find_usages reads incomplete even when it's actually complete. Load the target repo's configs like the primary does. daemon/host cross-root path. Builds on t-000073.
