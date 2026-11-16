---
id: t-281041
title: member_usages FAIL 'no type at the resolved position' на свойствах класса (Writer.baseItems/items)
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: bug
complexity: S
area: ts-core
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:54.202Z'
---
## Симптом
`member_usages {name:'Writer', file:'packages/chat-model/src/model.ts', member:'baseItems'}` (и `items`) → FAIL tool=ts-ls no type at the resolved position, хотя `find_usages` по тем же name+file резолвит `ts:Writer@…model.ts:683:7`. Вероятно, тип берётся у позиции имени класса как у value (constructor), а не у instance type.

## Минимальный исход
Для class-декларации `member_usages` берёт instance type (и static-сторону для static-членов).

## Фрикшены
f-kmz364cgazyu
Inbox: «member_usages fails to resolve class Writer» (2026-11-15T21:02).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
