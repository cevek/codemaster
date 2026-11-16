---
id: t-406178
title: source по name+file не находит методы/геттеры класса и методы объектного литерала (could not anchor a top-level declaration)
status: backlog
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: dx
complexity: M
area: ts-core
relates:
  - t-271823
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:51.921Z'
---
## Симптом
Самый частый фрикшен месяца (~14 записей): `source {name:'accountId', file:'…/journal.ts'}` и т.п. для методов классов, геттеров, методов объектного литерала, вложенных функций → `could not anchor a top-level declaration`. Агенты уходят в rg или угадывают координаты. Аналогично `expand_type` по имени импортированного `Page` (f-wfjbncbpc4sg).

## Контекст
Чекер-путь якорит только top-level (ARCHITECTURE §5-L2); `source {syntactic:true}` уже адресует вложенные декларации. Обобщение name+file на члены — t-271823 (там названы find_definition/expand_type, source нет).

## Минимальный исход
Дешёвая честная половина: ошибка `could not anchor` при наличии одноимённой вложенной декларации в этом файле называет её (`Class.method @file:line:col`) и runnable-редирект (`source {syntactic:true}` с теми же args / точная позиция). Полная — в рамках t-271823.

## Фрикшены
f-ajg3iohediep, f-fd373j7hibxu, f-sq3fl6ilt6y6, f-o4uunnlsux2e, f-34x43v6etdjd, f-flu347i7quns, f-33vt34nq576d, f-renj4zemkfzi, f-u7zcsxixr223, f-5nnn7ovuxqvd, f-rb4w36i3h5vy, f-u5ww2urm75u4, f-aitousrmqeqt, f-zxzkwdk2dygf, f-wfjbncbpc4sg

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
