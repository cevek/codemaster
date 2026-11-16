---
id: t-959725
title: '§7-гейт: extract_symbol/move_symbol в новый файл — программа, держащая source транзитивно, не получает новый файл в overlay'
status: backlog
priority: medium
tags:
  - dogfood
  - dogfood-nov
created_by_session: s-207994
type: bug
complexity: S
area: ts-refactor
audience: external
evidence: reported
author: mi-71ed3970
created: '2026-11-16T12:36:29.205Z'
---
## Симптом
Шов `claimedBy` (`src/plugins/ts/program-gate.ts`): программа, которая держит файл-источник ТРАНЗИТИВНО (по импорту, не по глобу: `containsFile`=true, `mayContain`=false), получает в overlay переписанный источник, но не новый файл, которым владеет глоб другой программы. Результат: ложное «Cannot find module» и каскад `unknown` → ложный отказ гейта. Для `move_file` закрыто в t-401540 парами `GateScope.moves`. У `extract_symbol` и `move_symbol` в новый файл source-пары нет: `plan.newFiles`, а не `plan.moves`.

## Минимальный исход
Новый файл extract/move_symbol достаётся каждой программе, которая `containsFile` файл, из которого он вырезан (та же нога, что у move-пар). Тест: sibling-программа держит source транзитивно, extract в dest под глобом primary проходит чисто.

Репро не снято, вывод по чтению кода в ходе t-401540.
