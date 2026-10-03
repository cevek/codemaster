---
id: t-310406
title: 'Забор дрейфа: restructures безусловен — tsconfig/package.json чужого пакета монорепо отказывает запись'
status: backlog
priority: low
tags:
  - gate
  - mutation
type: imp
complexity: S
evidence: reported
author: 8352d423
created: '2026-10-03T16:13:52.394Z'
---
`gateRelevance` (`plugins/ts/gate-membership.ts`) считает дрейфом любой `tsconfig*`/`package.json`/`pnpm-workspace.yaml`/`.gitignore` в дереве — даже в пакете, не участвующем ни в одной проверенной программе (остаток t-500739). Второй остаток той же природы: без цепочки конфига программы (`extends`, `typeRoots`/`types`) предикат консервативен — любой `.json` кроме lockfile и любой `.d.ts` в дереве считаются дрейфом (правка JSON-данных или чужого `.d.ts` даёт «re-run»). Решить оба через «файлы, от которых зависят проверенные программы» (`extendedSourceFiles` разобранного конфига + каталоги typeRoots) — вероятно новой функцией в `program/single.ts`.
