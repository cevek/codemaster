---
id: t-828499
title: 'memo результата гейта мутаций: install в gitignored-области между dry-run и apply при том же diskVersion отдаёт вердикт dry-run'
status: backlog
priority: low
parent: t-116306
depends_on:
  - t-710809
tags:
  - cache
  - gate
  - mutation
type: bug
complexity: S
evidence: reported
author: 4719392d
created: '2026-10-03T14:02:10.936Z'
---
## Проблема

`createGateCache` (`src/plugins/ts/program-gate-cache.ts`) хранит результат гейта мутаций целиком — memo по точному ключу из входов гейта и `SingleProgram.diskVersion()` каждой затронутой программы (apply после идентичного dry-run гейт не гоняет). Per-file диагностику memo не хранит: её единственный источник — builder (`program-gate-builder.ts`), который сверяет версии файлов, ключи `referencedMap` и compilerOptions с текущим Program LS и истории запросов не наследует.

Дисковый вид тёплого LS — это версии файлов плюс резолв модулей, а резолв TS переиспользует при пересборке Program (t-710809). Значит при одном и том же `diskVersion` дисковый вид может измениться, если между dry-run и apply поменялось gitignored-содержимое, куда резолвятся импорты (`pnpm add`, сборка/удаление `packages/x/dist/*.d.ts`). Тогда apply получит вердикт dry-run, вычисленный на прежнем резолве: ложный CLEAN, если прежний резолв скрывал ошибку, которую правка вносит при новом.


## Минимальный исход

Не воспроизведено (UNVERIFIED), вероятность низкая — требует совпадения ключа. Закрывается вместе с t-710809: как только дисковый вид LS перестаёт зависеть от истории (инвалидация резолва бампает `diskVersion`), кэш наследует это без правок.
