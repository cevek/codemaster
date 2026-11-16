---
id: t-742524
title: source по позиции метода объектного литерала, реализующего интерфейс, отдаёт член интерфейса без тела
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
created: '2026-11-16T09:41:52.371Z'
---
## Симптом
`source {file:'apps/server/src/index.ts', line:681, col:3}` — позиция на имени метода `inputRefusal` в объектном литерале — возвращает `HostInputDeps.inputRefusal` из hostRuntime.ts:60 (сигнатура интерфейса) вместо тела метода в указанной позиции.

## Почему
Чекер-путь СЛЕДУЕТ адресу (goToDefinition), а для имени свойства объектного литерала с контекстным типом LS ведёт в член контекстного типа. Но позиция уже стоит НА декларации — тело там.

## Минимальный исход
Если позиция — имя декларации (method/property assignment в литерале), `source` печатает её саму; контекстный член интерфейса — максимум как доп. строка.

## Фрикшены
f-s7zrilk2pp5t

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
