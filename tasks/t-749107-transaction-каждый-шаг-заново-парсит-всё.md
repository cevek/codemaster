---
id: t-749107
title: 'transaction: каждый шаг заново парсит всё дерево в rewriteImports — кэшировать в пределах цепочки'
status: backlog
priority: medium
parent: t-116306
tags:
  - mutation
  - perf
  - transaction
type: perf
complexity: M
evidence: reported
author: fad2132f
assignee: f0182919
created: '2026-10-03T13:35:30.479Z'
---
Найдено при разборе латентности мутаций (эпик t-713045). Каждый шаг `transaction` вызывает план (`planUnderOverlay` → `rewriteImports` в `plugins/ts/refactor/imports/`), который строит move-tree и разбирает импорты по всему дереву заново; на 13-шаговой цепочке это следующее узкое место после гейта (по профилю одного шага план ≈5.8 с на эталонном репо, из них `assemblePlan` ≈2.6 с). Не замерено по шагам цепочки — первым делом снять профиль 8-шаговой транзакции.
