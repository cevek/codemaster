---
id: t-698933
title: 'move_symbol/extract_symbol: type-позиционные ссылки через namespace-импорт (M.Model, typeof M.fn) не переписываются — перенос отказывает'
status: backlog
priority: high
parent: t-116306
tags:
  - mutation
  - namespace
type: bug
complexity: M
area: ts-refactor
evidence: repro
author: c37d629d
assignee: c0c4edfa
created: '2026-10-03T16:26:41.811Z'
---
Consumer `import * as M from '../model.ts'` использует перенесённый символ в TYPE-позиции: `M.Model` (тип) или `typeof M.setName`. LS «Move to file» (апстрим TS 6.0.3, `updateNamespaceLikeImport`) переписывает только рефы, чей родитель — PropertyAccessExpression; QualifiedName пропускается. Итог: `Namespace has no exported member 'Model'` / `Property 'setName' does not exist` — гейт честно отказывает, но перенос типа, которым пользуются через namespace, невыполним.

Repro (разбор t-932492, фикстуры S14/S15): move_symbol Model из src/feat/model.ts в существующий src/feat/types.ts при consumer `function run(m: M.Model)`; move_symbol setName при `export const f: typeof M.setName = M.setName`. Во втором случае LS вставил импорт dest и переписал value-реф, а typeof-реф остался висеть.

Минимальный исход: в нормализаторе namespace-импорта (`reconcileNamespaceImports`, src/plugins/ts/refactor/imports/reconcile-namespace-import.ts, t-932492) дописать QualifiedName-рефы на перенесённые символы к выбранному alias dest, когда LS вставку сделал. Развилка (ниже, не решена): все рефы типовые → LS не вставляет импорт вовсе, нужна генерация спецификатора.
