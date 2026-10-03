---
id: t-828499
title: 'кэш baseline гейта мутаций: устаревший резолв в gitignored-области без install-маркера может дать ложный clean'
status: backlog
priority: low
tags:
  - cache
  - gate
  - mutation
type: bug
complexity: S
evidence: reported
author: 4719392d
created: '2026-10-03T14:02:10.936Z'
depends_on:
  - t-710809
---
## Проблема

`createGateCache` (`src/plugins/ts/program-gate-cache.ts`) хранит baseline-диагностики гейта мутаций по `SingleProgram.diskVersion()`. Дисковый вид тёплого LS — это версии файлов плюс резолв модулей, а резолв неизменённого файла TS переиспользует при пересборке Program и обновляет только когда сам файл получает новый SourceFile — в том числе при откате dry-run overlay, который этот файл затрагивал (t-710809). Значит при одном и том же `diskVersion` дисковый вид меняется в зависимости от истории запросов, если между ними изменилось gitignored-содержимое, куда резолвятся импорты (`pnpm add`, сборка/удаление `packages/x/dist/*.d.ts`).

Ложный ОТКАЗ из-за этого невозможен: `gateAcross` (`program-gate.ts`) пересчитывает закэшированный baseline с диска, если overlay содержит непокрытую им диагностику. Остаётся ложный CLEAN: закэшированный baseline содержит ошибку, которой в текущем дисковом виде уже нет (`Cannot find module 'foo'` до установки), а правка вносит ровно её же (тот же file:line:message) — multiset-diff в `introducedDiagnostics` её поглотит.

## Минимальный исход

Не воспроизведено (UNVERIFIED), вероятность низкая — требует совпадения ключа. Закрывается вместе с t-710809: как только дисковый вид LS перестаёт зависеть от истории (инвалидация резолва бампает `diskVersion`), кэш наследует это без правок.
