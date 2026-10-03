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


## Отчёт

### Стенд и метод съёма

- Эталон `/Users/cody/Dev/amiro` (главный чекаут; HEAD двигался между прогонами `2a4daafe9` → `48e133cb2`, 3795→3797 root-файлов; внутри одного прогона дерево — снапшот в памяти). Программа 5388 файлов, из них 3801 non-lib. TS 6.0.3 (тот же, что у codemaster). Машина 12 ядер / 32 ГБ, load average 9–18 (параллельные треки) → разброс большой, везде даю min–медиана–max.
- `node --expose-gc --max-old-space-size=8192 scripts/spike/builder-gate/amiro.mjs /Users/cody/Dev/amiro <scenario> [--full=all] [--chain=linear] [--presign] [--release] [--mode=ls]`; ловушки — `node scripts/spike/builder-gate/traps.mjs`; распределение замыканий — `why.mjs <root>`.
- Builder-проход: `B_k = ts.createSemanticDiagnosticsBuilderProgram(service.getProgram(), host, B_prev)` → drain `getSemanticDiagnosticsOfNextAffectedFile` → чтение syntactic + `B_k.getSemanticDiagnostics(sf)` всех non-lib файлов (то, что потребляет гейт).
- «Полный» эталон = работа текущего гейта на тех же файлах: `ts.createProgram({oldProgram})` поверх тех же SourceFile (без репарса) → свежий checker → syntactic+semantic всех non-lib. Контрольно сверен с настоящей LS-поверхностью гейта (`service.get{Syntactic,Semantic}Diagnostics` per file, `--mode=ls`): 25.8 / 39.5 / 34.8 / 27.6 с — тот же порядок.
- Работа builder = число вызовов `program.getBindAndCheckDiagnostics` на инстансе Program (патч) — реально перепроверенные файлы. Время = `performance.now()` вокруг прохода. heap = `heapUsed` после `gc()`.
- Правки — настоящие edits LS-рефактора «Move to a new file» (тот же, что ведёт `extract_symbol`) и `getEditsForFileRename` (move_file):
  - **leaf**: `src/public/lead-main.tsx` → `LeadFormApp` в новый файл; 2 файла overlay.
  - **form-model**: `src/lib/forms/form-model.ts` → `LocalizedStrings`; 10 файлов overlay (97 прямых импортёров).
  - **hub**: `src/lib/i18n.ts` → `useTranslation`; 893 файла overlay.
  - **move-file**: `dev-recorder/src/recorderStore.ts` → `…-moved.ts` + tombstone; 7 файлов. **move-file-missed** — то же без переписи одного импортёра (положительный контроль на amiro: 2 диагностики).
- Цепочка «gate» (форма интеграции): G0 baseline (холодный builder) → G1 overlay ← B0 → G2 post-write ← B1 (overlay-байты под новыми версиями = диск после apply) → G3 диск ← B0 (следующий baseline) → G4 тот же overlay ← B0 повторно. Цепочка «linear» (P0→P1→P2→P3 строго подряд) снята в первом раунде.

### 1. Время проходов (с)

| проход | builder | полный (эталон) | перепроверено файлов |
|---|---|---|---|
| холодный baseline (G0/P0), n=12 | 19.7 – **22.2** – 42.3 | все прогоны полного, n=56: 21.4 – **27.9** – 79.9 | 3801 / 3801 |
| overlay, leaf (n=5) | 0.78 – **0.92** – 1.07 | ≈ полный | 3 |
| overlay, form-model (n=6) | 13.2 – **15.0** – 17.5 | ≈ полный | 2194–2195 |
| overlay, move-file(-missed) (n=7) | 13.3 – **17.3** – 24.7 | ≈ полный | 2071–2072 |
| overlay, hub i18n (n=5) | 20.2 – **22.2** – 37.3 | ≈ полный | 3039–3055 |
| post-write ← B1 (leaf / form-model / move-file / hub) | 0.32–0.44 / 0.47–0.50 / 0.53–0.56 / 13.4–14.6 | ≈ полный | 2 / 10 / 6 / 893 |
| диск ← B0 (следующий baseline на неизменном диске) | 0.65 – 3.74 (это сборка Program, не проверка) | ≈ полный | 0 |

Цена overlay-прохода определяется не размером правки, а `referencedMap`-замыканием изменённых файлов. Распределение по amiro (`why.mjs`): **бимодальное** — у 33.0% файлов замыкание ≤ 1% репо, у 67.0% — ≈ 55% репо (2066–2192 файла: одна большая компонента обратных ссылок; наивный подсчёт импортёров по `sf.imports` её не видит — у `DevRecorder.tsx` он давал 8, `referencedMap` даёт 2066). Промежуточных значений нет. Отсюда: правка «вне ядра» — ×25 быстрее; правка в ядре — ×1.5–2; хаб, правящий ~900 файлов, — ×1–1.3, в отдельном прогоне медленнее полного (37.3 против 26.3).

### 2. Root-set change (новый файл / tombstone)

Состояние builder переиспользуется: affected ≠ всё. Новый файл (все extract-сценарии) и tombstone (move-file) дают ту же цену, что их замыкание: leaf с новым файлом — 3 файла, move-file с tombstone — 2072 (= замыкание удалённого `recorderStore.ts`, 2071 + новый файл). Ловушка «tombstone с пропущенным импортёром» на фикстуре и на amiro (move-file-missed) — ошибка `2307` найдена builder-путём на каждом проходе.

### 3. Эквивалентность

- amiro: мультимножество `(file,start,length,code,message)` builder-пути == полного прохода на **каждом** проходе **каждого** сценария, в обеих цепочках, с pre-sign и без, с `releaseProgram` и без (58 сравнений в сохранённых логах + 4 в первом leaf-прогоне, все EQUAL, ни одного DIFF; в move-file-missed — по 2 диагностики с обеих сторон, в остальных amiro чист → там равенство «пусто = пусто», содержательная проверка — ловушки и move-file-missed).
- Ловушки (`traps.mjs`, isolatedModules off и on, на каждой — положительный контроль «ошибка есть в полном проходе», + декои z.ts/zu.ts, которые на инкрементальных шагах НЕ перепроверяются): type passthrough `export type U = T` в 1 и 2 хопа, `export *`-barrel (retype и remove), `declare global` вынесен в не-модуль, tombstone с пропущенным импортёром, const enum, module augmentation из файла, который никто не импортирует, non-module script — все EQUAL. Ветвление от удерживаемого B0 (B1←B0, B2←B0, B4←B0) — EQUAL, B0 не портится.
- **Негативный контроль / граница применимости**: при `assumeChangesOnlyAffectDirectDependencies: true` (пользовательская compilerOption) passthrough-ловушка даёт DIFF — builder пропускает `c.ts|2322`, т.е. ложный clean. Builder-путь обязан отказываться от такого проекта (полный проход).
- Механика (прочитано в `typescript.js`, `handleDtsMayChangeOfReferencingExportOfAffectedFile`): при смене d.ts-сигнатуры файла инвалидируется ВСЁ транзитивное обратное замыкание по `referencedMap`; iso-ветка (`isolatedModules`/`verbatimModuleSyntax`, как у amiro) не делает `return` и проваливается в ту же общую — поэтому passthrough честен и при iso.

### 4. Память, parity, cancellation

- Память — удержание не от builder: текущий LS-путь (`--mode=ls`) на цепочке из 4 проходов выходит на плато heapUsed 1816 → **2773 МБ**; builder-цепочка linear — 1814 → **2528**, сброс builder это число не меняет. Удерживаемые builder без `releaseProgram()` держат свой Program+checker: gate-цепочка с B0 и B1 живыми — до 3234–3318 МБ (+~0.7 ГБ). С `releaseProgram()` после drain (старому состоянию Program не нужен — `createBuilderProgramState` читает у oldState только `compilerOptions`/карты): settled после post-write 1865–1892 МБ, т.е. ≈ LS-only.
- Оракул (лишний свежий checker) поверх этого валит дефолтный heap (OOM на 3-м проходе при 4 ГБ) — замеры с оракулом шли на 8 ГБ. Сам builder-путь в 4 ГБ укладывается.
- Parity c LS: при `declaration: true` `LS.getSemanticDiagnostics` добавляет declaration-диагностики (`program.getDeclarationDiagnostics`), builder — нет (ловушка: TS4094 только у LS). У amiro `noEmit` → не проявляется; у codemaster-подобных проектов с `declaration:true` — проявится. Нужен отдельный кэш declaration-диагностики по тем же affected-файлам.
- Cancellation: токен в `getSemanticDiagnosticsOfNextAffectedFile(token)` бросает `ts.OperationCanceledException` (на baseline после ~200 файлов, на overlay после 5); новый builder поверх прерванного на том же Program доходит до результата, EQUAL с полным. Сколько частичного прогресса переживает прерывание — не установлено (счётчик на том же Program считает и повторные чтения из кэша программы).

### Опровергнутые гипотезы и ловушки метода

- **drain-список как мера работы** — недооценивает в сотни раз: drain=7, реально перепроверено 2071; инвалидированный хвост проверяется лениво при чтении `getSemanticDiagnostics`. Мерить только по вызовам checker.
- **Штраф первого перехода**: холодный builder пишет версии файлов вместо сигнатур (`useFileVersionAsSignature = !useOldState`; `disableUseFileVersionAsSignature` наружу не выставлен), поэтому первая же правка — даже комментарий — инвалидирует замыкание (фикстура: 3 файла вместо 1). **Pre-sign** (внутренний `ts.BuilderState.computeDtsSignature` для файлов, которые overlay вот-вот изменит, на baseline-программе) на фикстуре снимает штраф (3 → 1), но на amiro **не помогает**: form-model 2195 → 2195 (сигнатура исходного файла меняется по существу), hub 3055 → 3039, move-file 2072 → 2072 (почему — не установлено; вероятно, d.ts импортёров ссылается на путь удаляемого модуля). Не нужен.
- Предположение «iso ⇒ распространение останавливается на файлах с неизменной сигнатурой» — неверно (см. механику выше), passthrough-ловушка это подтверждает.

### Вывод: стоит — но как отдельный трек ПОСЛЕ треков 1–2, с честно названным потолком

- Builder — единый механизм, который закрывает все три прохода гейта и проверяет свою корректность сам (TS-модель `tsc --incremental`, не наш граф импортёров): baseline на неизменном диске ← B0 = 0 перепроверок (то же, что даёт кэш трека 2); post-apply ← B1 = только изменённые файлы, 0.3–0.6 с (≈ то, что ищет трек 1; кроме hub-правок — 14 с); overlay — замыкание.
- Но выигрыш на overlay-проходе — главном, который останется после треков 1–2, — бимодален: ×25 для трети файлов amiro, ×1.5–2 для двух третей, ≈0 для правок-хабов. Типичный extract/move в «ядре» приложения остаётся 13–17 с против ~22–28.
- Цена интеграции средняя, риски перечислены ниже. Если трек 2 + трек 1 уже убирают два из трёх полных проходов, builder докупает ~40% оставшегося на «ядерных» правках и почти всё — на периферийных.

### Эскиз интеграции

1. На `SingleProgram`: `diskBuilder` (B0) — строится лениво первым гейтом поверх `service.getProgram()` при пустом overlay; после drain — `releaseProgram()`. При `reindex` (диск сменился) — `B0' = builder(LS program, B0)` + drain + release (инкрементально, цена = замыкание изменившегося).
2. `gateAcross`: baseline-диагностика = `B0.getSemanticDiagnostics(sf)` + syntactic (без проверки). Overlay: `setOverlay` → `B1 = builder(LS program, B0)` → drain с `HostCancellationToken` дедлайна → читать `B1.getSemanticDiagnostics(sf)` по `checkPaths` → `clearOverlay`. B1 сохранить (после release) для post-apply. Симметрия baseline/overlay сохраняется: оба читаются по одному и тому же `checkPaths` на каждом affected-program — фан-аут по программам остаётся как есть, каждая со своей цепочкой.
3. Post-apply: после записи и reindex `B2 = builder(LS program, B1)` (тот же текст ⇒ перепроверка = изменённые файлы); B2 становится новым B0.
4. Отказ от builder-пути (полный проход, как сейчас): `assumeChangesOnlyAffectDirectDependencies`, `outFile`, `noCheck`; при `declaration`/`composite` — добавить кэш `getDeclarationDiagnostics` (или идти полным путём до него).

### Риски интеграции

- **Ложный clean через опцию** `assumeChangesOnlyAffectDirectDependencies` — доказан ловушкой; гейт обязан проверять опцию.
- **Declaration-parity** при `declaration:true` — builder молча теряет TS4xxx; без своего кэша — расхождение с текущим гейтом.
- **Память**: забытый `releaseProgram()` на удерживаемом builder = +~0.7 ГБ на amiro (in-process daemon ниже порога эскалации); с release — ≈0.
- **Хаб-правки** (сотни изменённых файлов) могут быть медленнее полного прохода (d.ts-сигнатуры + обход) — нужен порог «изменено > N файлов ⇒ полный проход» либо принять паритет.
- **Транзакции** (N шагов поверх `PlanningOverlay`) не замерены: overlay каждого шага — ветка от B0 с растущим набором изменённых файлов; ожидаемо цена = объединённое замыкание.
- **Внутренние API не нужны** для рекомендованной формы: `createSemanticDiagnosticsBuilderProgram`, `getSemanticDiagnosticsOfNextAffectedFile`, `getSemanticDiagnostics`, `releaseProgram` — публичные. Builder патчит `program.getBuildInfo` на LS-программе — безвредно, но это запись в чужой объект.
- Обратно: LS `getProgram()` пересобирает Program при любом бампе версии overlay; builder ничего не меняет в этой стоимости (сборка 0.5–1.7 с на проход остаётся).
