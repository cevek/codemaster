---
id: t-439159
title: Мутация с чистым typecheck-гейтом откатывается по таймауту избыточного post-apply прохода; post-apply = третья полная проверка программы
status: backlog
priority: high
parent: t-713045
tags:
  - gate
  - honesty
  - mutation
  - perf
type: bug
complexity: M
evidence: measured
author: fad2132f
assignee: 0da85b47
created: '2026-10-03T13:35:11.681Z'
---
Контекст и замеры — эпик t-713045.

## Дефект

- Post-apply `diagnosticsAcross` (`plugins/ts/program-gate.ts`, вызов в `ops/refactor-apply.ts` и `ops/refactor-plan-apply.ts`) — третий полный проход проверки по уже проверенным overlay-гейтом байтам; на эталонном репо ≈20 с.
- Он делит один op Deadline с планом и гейтом. Наблюдалось: `transaction` из 13 шагов, ответ `typecheck=clean`, `rollback.performed=true`, `reason=post-apply typecheck threw (DeadlineExceededError…)` — откат доказанно безопасной правки (§3.6 наоборот).

## Решённое направление (менеджер; детали — твой план)

- Таймаут/отмена ПОСЛЕ записи никогда не вызывает rollback: правка остаётся, на конверте честная нота, что финальная проверка не завершилась. Rollback — только на доказанную ошибку.
- Полный post-apply проход заменить дешёвой проверкой того, что гейт НЕ покрыл: readback записанных байтов против проверенных; §3.5-отпечаток репо перед записью (отказ при дрейфе с момента входа) — сегодня его нет; диагностика по touched ∪ new (как rename). Узкий residual (dest вне glob всех программ, `claimedBy` в `program-gate.ts`) — решить в плане.
- Два почти одинаковых post-apply блока — свести в одно место.

Гипотеза, не рамка: опровергнешь посылку по коду — доложи.
