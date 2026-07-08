---
id: t-228533
title: programs:/includePrograms per-call lever to widen the loaded program set (t-000073 ask 2)
status: backlog
priority: medium
depends_on:
  - t-000073
type: feat
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T09:11:26.092Z'
---
Ask 2 of t-000073. The LOWER-BOUND note prescribes 'reference the config to recover a complete count' but there is NO op/flag to do so. Add a per-call arg 'programs:[paths]' / 'includePrograms' (mirroring 'root') so ONE call can widen the search over otherwise-undiscovered tsconfigs. Read ops (find_usages/importers_of/find_unused_exports) + the ts host on-demand extra-program load. Builds on the workspace-discovery foundation (t-000073).
