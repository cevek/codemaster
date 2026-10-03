---
id: t-820012
title: 'Спайк: SemanticDiagnosticsBuilderProgram поверх Program LS для typecheck-гейта — замер на amiro, без прод-кода'
status: in-progress
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


## Разбор по ходу (промежуточно, итог ниже допишется)

- Эталон: `/Users/cody/Dev/amiro` @ `2a4daafe9` (pp-polish удалён). 3795 root-файлов, программа 5386, TS 6.0.3. Все root-файлы читаются в память на старте (снапшот), дерево не пишется.
- Скрипт: `scripts/spike/builder-gate/` (`lib.mjs` — LS-хост по образцу `program/single.ts` + проходы; `traps.mjs`; `amiro.mjs`; `why.mjs`).
- Метрика «работы» — не drain-список builder, а патч `program.getBindAndCheckDiagnostics` на инстансе Program: число реально перепроверенных файлов. drain-список её НЕДООЦЕНИВАЕТ: инвалидированный транзитивный хвост перепроверяется лениво при чтении `getSemanticDiagnostics` (drain=7, rechecked=2071).
- Ловушки (8 шт. × isolatedModules on/off, с декоями z.ts/zu.ts): все EQUAL с полным проходом, положительный контроль ok на каждой, декои на инкрементальных шагах не перепроверяются (т.е. builder реально пропускает работу, а не проходит насквозь). Проверены: passthrough `export type U = T` (1 и 2 хопа), `export *`-barrel (retype/remove), `declare global` вынесен в не-модуль, tombstone с пропущенным импортёром, const enum, module augmentation из файла, который никто не импортирует, non-module script.
- Механика TS 6 (прочитано в `typescript.js`, `handleDtsMayChangeOfReferencingExportOfAffectedFile`): при смене d.ts-сигнатуры файла инвалидируется ВСЁ транзитивное обратное замыкание по `referencedMap` — и при isolatedModules тоже (iso-ветка не делает return и проваливается в общую). Поэтому passthrough-ловушка честная.
- Первый переход после холодного builder: сигнатуры = версии файлов (`useFileVersionAsSignature = !useOldState`), поэтому любой изменённый файл считается «сменившим сигнатуру» даже при правке комментария (ловушки: benign → замыкание; benign-again → 1 файл). Флаг `disableUseFileVersionAsSignature` для builder-программы наружу не выставлен.
- amiro: `referencedMap`-замыкание у файлов в «ядре» приложения ≈ 2066–2192 из 3799 (55–58%) — в т.ч. у `dev-recorder/src/DevRecorder.tsx` (наивный подсчёт импортёров давал 8). Большая компонента обратных ссылок (вероятно, цикл router/routeTree), любой файл в ней при смене сигнатуры тянет ~2070 файлов.
- `declaration:true`: builder `getSemanticDiagnostics` НЕ содержит declaration-диагностик (TS4094 есть у `LS.getSemanticDiagnostics`, нет у builder) — для parity нужен отдельный `program.getDeclarationDiagnostics` по affected.
- Память (контроль): текущий LS-путь (per-file `service.getSemanticDiagnostics`) на цепочке P0..P3 даёт плато heapUsed 1816 → 2773 МБ; builder-цепочка — 1814 → 2528 МБ, сброс builder не меняет (2529). Удержание — свойство LS/общих SourceFile, не builder. Оракульный проход (лишний свежий checker) поверх этого валит дефолтные 4 ГБ — оракул гоняется с `--max-old-space-size=8192`.
