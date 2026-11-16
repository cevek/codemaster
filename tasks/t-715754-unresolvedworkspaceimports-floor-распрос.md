---
id: t-715754
title: 'unresolvedWorkspaceImports floor: распространить на importers_of / find_definition / find_unused_exports / scan-fanout / trace_type_widening'
status: backlog
priority: medium
created_by_session: s-207994
type: bug
complexity: M
area: multi-program
evidence: reported
author: mi-5302e415
created: '2026-11-16T12:46:13.505Z'
---
## Что
Floor `unresolvedWorkspaceImports` (`src/plugins/ts/unresolved-workspace-imports.ts` `unresolvedWorkspaceImports` / `unresolvedWorkspaceNote`) сейчас стоит только на `find_usages` и `member_usages`. Остальные потребители floor полноты ссылок/импортов его не несут: `importers_of` (`plugins/ts/importers.ts`, `importers-subtree.ts`), bare-name `find_definition`, `find_unused_exports` (демоут `certain` → `partial`), scan-fanout (`construction_sites` / `discrimination_sites`), `trace_type_widening`. Импорт своего workspace-пакета, который не резолвится (необъявленная зависимость, не-`workspace:` диапазон, вход в несобранный `dist`), у них даёт тихий недосчёт: импортёр не входит в программу декларации.

## Минимальный исход
Каждый из названных op'ов выставляет `complete:false` (или демоутит `certain`) и несёт то же поле + ноту, когда floor непуст. Вычисление — только там, где op и так строит все программы (правило admission §5-L2); где не строит, сначала решить, допустима ли цена.
