---
id: t-041300
title: '§7-гейт: primary, который сам extends-only base (корневой tsconfig.json без files/include), судит каждый перенос под base-опциями'
status: backlog
priority: medium
tags:
  - dogfood
  - dogfood-nov
created_by_session: s-207994
type: bug
complexity: M
area: ts-refactor
audience: external
evidence: reported
author: mi-71ed3970
created: '2026-11-16T12:36:29.772Z'
---
## Симптом
В t-401540 extends-only base-конфиг (без `files`/`include` в цепочке, цель `extends` других загруженных конфигов) исключён из `affected` write-гейта, но только для SIBLING-программы. Частая раскладка: корневой `tsconfig.json` содержит одни compilerOptions, пакеты его extends. Тогда primary сам pure-base: его дефолтный `**/*` глоб владеет каждым файлом, и гейт судит `.tsx` пакета без `jsx`/DOM. Получаем ложные introduced и отказ, как в t-401540. Primary исключить нельзя: он никогда не degraded (его throw = гейт ничего не проверил) и он запасной владелец ничейных путей (`claimedBy`).

## Минимальный исход
Primary-base не судит файлы, которыми владеет другая (реальная) программа; ничейные пути и throw-гарантия остаются за ним. Тест: корневой tsconfig.json без include и без jsx, пакет с jsx, перенос .tsx в пакете чистый.

Репро не снято: вывод по чтению кода в ходе t-401540.
