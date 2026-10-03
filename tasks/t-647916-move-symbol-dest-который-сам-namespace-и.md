---
id: t-647916
title: 'move_symbol: dest, который сам namespace-импортирует source и зовёт перенесённый символ через M.x, остаётся с висящей ссылкой'
status: backlog
priority: low
tags:
  - mutation
  - namespace
type: bug
complexity: S
area: ts-refactor
evidence: repro
author: c37d629d
created: '2026-10-03T16:26:42.429Z'
---
Dest src/feat/i18n.ts содержит `import * as M from './model.ts'` и `M.setName(...)`; move_symbol setName из model.ts в i18n.ts. LS не переписывает `M.setName` в локальный `setName` → `Property 'setName' does not exist on type typeof import(model)`, гейт отказывает. Минимальный исход: ref на перенесённый символ в самом dest → голый локальный идентификатор (если не затенён); ставший неиспользуемым ns-импорт source — удалить. Repro: фикстура S4 в разборе t-932492.
