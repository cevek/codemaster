---
id: t-132219
title: 'move_symbol/extract_symbol: consumer с import X = require / const X = require(source) получает расходящиеся имя импорта и ссылок (тот же апстрим-баг updateNamespaceLikeImport)'
status: backlog
priority: low
parent: t-116306
tags:
  - mutation
  - namespace
type: bug
complexity: S
area: ts-refactor
evidence: reported
author: c37d629d
assignee: c0c4edfa
created: '2026-10-03T16:37:01.216Z'
---
Апстрим TS 6.0.3 `updateNamespaceLikeImport` обслуживает три формы namespace-like импорта (`getNamespaceLikeImport`: ImportDeclaration, ImportEqualsDeclaration, VariableDeclaration с require) и во всех вставляет импорт dest с preferred-именем, а рефы переписывает в `getUniqueName` (`_N`). Нормализатор `reconcileNamespaceImports` (src/plugins/ts/refactor/imports/reconcile-namespace-import.ts, t-932492) чинит только ImportDeclaration; формы `import X = require('…')` и `const X = require('…')` остаются с расхождением — гейт отказывает. Минимальный исход: расширить распознавание вставки на эти два вида узлов. Repro на фикстуре не снят (нужен module: commonjs) — evidence=reported по чтению кода TS.
