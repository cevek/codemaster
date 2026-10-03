---
id: t-820012
title: 'Спайк: SemanticDiagnosticsBuilderProgram поверх Program LS для typecheck-гейта — замер на amiro, без прод-кода'
status: backlog
priority: medium
parent: t-713045
tags:
  - gate
  - mutation
  - perf
  - spike
type: perf
complexity: M
evidence: measured
author: fad2132f
assignee: 8f13e902
created: '2026-10-03T13:35:26.419Z'
---
Контекст и замеры — эпик t-713045.

## Вопрос

Может ли гейт перепроверять только affected-файлы по модели `tsc --incremental`: `ts.createSemanticDiagnosticsBuilderProgram(service.getProgram(), host, prevBuilder)` цепочкой по версиям Program LS (baseline → overlay → снятие overlay → после записи), с обязательным drain `getSemanticDiagnosticsOfNextAffectedFile` перед чтением?

## Ответить цифрами (эталон `/Users/cody/Dev/worktrees/amiro/pp-polish`, проект НЕ мутировать — только overlay в памяти)

1. Время каждого прохода (первый холодный, overlay, повтор baseline) для двух правок: extract из листового файла и из хаба (например `src/lib/forms/form-model.ts`).
2. Переиспользуется ли builder state, когда правка меняет root-set (новый файл / tombstone) — или affected = всё.
3. Эквивалентность: множество диагностик builder-пути == полный проход на тех же Program (на amiro и на сконструированных ловушках: `export *`-barrel, `declare global` в переносимом блоке, tombstone с пропущенным импортёром, const enum, `isolatedModules` on/off).
4. Память (heapUsed до/после), parity с LS `getSemanticDiagnostics` (declaration-диагностика при `declaration:true`), проброс cancellation token.

## Выход

Отчёт в теле таски: цифры + вывод «стоит/не стоит» + эскиз интеграции и её риски. Код спайка — скрипт вне `src/` (или вообще не коммитится); прод-код не меняется.
