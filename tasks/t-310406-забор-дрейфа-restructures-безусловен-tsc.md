---
id: t-310406
title: 'Забор дрейфа: restructures безусловен — tsconfig/package.json чужого пакета монорепо отказывает запись'
status: backlog
priority: low
parent: t-116306
tags:
  - gate
  - mutation
type: imp
complexity: S
evidence: reported
author: 8352d423
created: '2026-10-03T16:13:52.394Z'
---
`gateRelevance` (`plugins/ts/gate-membership.ts`) считает дрейфом любой `tsconfig*`/`package.json`/`pnpm-workspace.yaml`/`.gitignore` в дереве — даже в пакете, не участвующем ни в одной проверенной программе (остаток t-500739). Обратная сторона сужения: `.json`-цель `extends` с не-tsconfig именем (`configs/base.json`) вне программ больше не дрейф — тот же класс, что пробел членства в `program/single.ts`. Решить оба через «конфиги, от которых зависят проверенные программы».
