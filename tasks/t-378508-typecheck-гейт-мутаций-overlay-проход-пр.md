---
id: t-378508
title: 'typecheck-гейт мутаций: overlay-проход проверяет всю программу — перевести на SemanticDiagnosticsBuilderProgram (замыкание referencedMap)'
status: in-progress
priority: high
parent: t-116306
tags:
  - gate
  - mutation
  - perf
type: perf
complexity: L
evidence: measured
author: fad2132f
assignee: 0c78fe37
created: '2026-10-03T14:54:55.822Z'
---
Цифры, метод, эквивалентность, эскиз интеграции и риски — в отчёте спайка t-820012 (скрипты `scripts/spike/builder-gate/`). Кэш baseline (t-786607) и узкий post-apply (t-439159) уже убрали два из трёх полных проходов; остался overlay-проход гейта — полная проверка программы (~22–28 с на `/Users/cody/Dev/amiro`).

Builder-путь на overlay: ×25 для правок вне «ядра» (33% файлов amiro, ~0.9 с), ×1.5–2 в ядре (13–17 с — большая компонента обратных ссылок ~2070 файлов), ≈0 или хуже для hub-правок (сотни изменённых файлов).

Обязательные условия (из спайка): отказ от builder-пути при `assumeChangesOnlyAffectDirectDependencies` (доказанный ложный clean), `outFile`, `noCheck`; parity declaration-диагностики при `declaration`/`composite`; `releaseProgram()` после drain (иначе +0.7 ГБ); порог «изменено > N файлов ⇒ полный проход». Не замерены: транзакции, rename на builder-пути, частичный прогресс после cancel.


## План

### Решение по двум авторитетам
Вопрос «диагностика файла на дисковой версии» получает ОДНОГО владельца — состояние TS-builder (`semanticDiagnosticsPerFile` + сигнатуры + `referencedMap`, перенос через `oldState`). Из t-786607:
- **поглощается и удаляется**: per-file `Generation` (`baseline`/`refresh` в `program-gate-cache.ts`) — builder и есть этот кэш, но инвалидируется самим TS по версиям файлов/`referencedMap`/compilerOptions ТЕКУЩЕГО дискового Program, а не по нашему `diskVersion`. История резолва (t-828499) перестаёт его касаться: baseline каждый гейт читается из builder над Program, который LS собрал сейчас.
- **остаётся**: memo целого `GateResult` по точному ключу (apply после идентичного dry-run) — другой вопрос («вердикт этих входов»); `diskVersion()` остаётся ключом только для него. Пересчёт-перед-отказом (`uncoveredFiles`) остаётся, но как ОРАКУЛ: файл с непокрытой overlay-диагностикой перечитывается прямым `fileDiagnostics` LS — «builder ускоряет только CLEAN» верно дословно.
- **post-apply (t-439159)**: `diagnosticsAcross` переходит на тот же builder-проход (родитель — overlay-builder последнего гейта: те же байты ⇒ перепроверяются только записанные файлы, замыкание не тянется). Логика скоупа (`claimDivergence` → расширение до полного scope) в `ops/post-apply-verify.ts` не меняется — расширенный scope на builder дёшев. Результат post-apply становится новым дисковым состоянием.
- Корректность НЕ зависит от выбора родителя (модель `tsc --incremental`: любое oldState) — выбор родителя только про цену. Это одно утверждение кладу комментарием в код.

### Подход (файлы)
1. Новый `plugins/ts/program-gate-builder.ts`: `createGateBuilders()` — `WeakMap<SingleProgram, {disk?, afterGate?}>`; одна функция прохода `pass(program, parent, checkAbs, token)` = create → drain `getSemanticDiagnosticsOfNextAffectedFile(token)` → чтение syntactic (Program) + `builder.getSemanticDiagnostics(sf, token)` + при `declaration||composite` `builder.getDeclarationDiagnostics(sf, token)` → `releaseProgram()` → `{diags, state}`; `state` — непрозрачная обёртка (из released builder читать нельзя — assert TS). Вид builder: `declaration||composite` → `createEmitAndSemanticDiagnosticsBuilderProgram` (parity с LS по declaration-диагностике, `decl.mjs`), иначе `createSemanticDiagnosticsBuilderProgram` (замерено спайком). Цепочка продвигается только после успешного прохода; throw (cancel/LS) → полудренированный builder выброшен, родитель остаётся.
2. Отказ от builder-пути per program (→ существующий `collectFromService`, единственный оракул для таких программ): `assumeChangesOnlyAffectDirectDependencies` (доказанный ложный clean), `outFile`, `noCheck`; overlay уже активен (как сейчас у кэша); только для overlay-прохода — порог «записей+tombstone этой программы > max(50, 10% файлов программы)» (спайк: 893/3801 ≈ паритет или хуже) — тогда baseline всё равно из builder, overlay — LS, `afterGate` не пишется.
3. `program-gate.ts`: `GateHostCtx` + `builders?` и `cancel?` (аддитивно); `sample()` и `diagnosticsAcross` идут через builder при eligible; иначе — как сейчас. Симметрия baseline/overlay (инварианты 1–2 шапки) без изменений: оба прохода читают тот же `checkAbs` на тех же программах.
4. `program-gate-cache.ts`: только result-memo + `idOf`.
5. `diagnostics.ts`: вынести маппер `Diagnostic → TsDiagnostic` из `fileDiagnostics` — один формат для обоих путей.
6. `ls-host.ts`: создать `builders`, передать `cancellation.cancel` в `gateCtx` — токен строю над ним (`throwIfCancellationRequested` → `OperationCanceledException`, `withDeadline` уже переводит).
7. Доки (строки, которые правка делает ложью): ARCHITECTURE §3.1 (третий memo), §7 «gate cached against the disk», §15; `src/README.md`.
8. t-828499: дописать, что baseline-часть закрыта builder'ом; остаток — result-memo по `diskVersion` (install между dry-run и apply при том же diskVersion) — до t-710809. Перескоуп текста, не закрытие.

### Развилки
- **Где цепочка**: хост-уровень (`WeakMap` по программе, как кэш t-786607), не внутри `SingleProgram` — тот же цикл импортов `single.ts → diagnostics → ls-host`; владелец версий по-прежнему `SingleProgram`, builder читает их через Program.
- **Builder вместо per-file кэша, а не рядом**: альтернатива «builder только для overlay, baseline из per-file map» оставила бы два авторитета и history-dependence t-828499.
- **Declaration**: Emit-вариант builder, а не отказ от builder-пути: сам codemaster `declaration:true` — отказ выключил бы выигрыш на догфуд-репо. Известный потолок: первый `getDeclarationDiagnostics` дренирует dts-ошибки всего affected-замыкания независимо от `checkAbs` — rename на declaration-проекте платит замыкание; замерю на codemaster и назову.
- **Хаб-порог** — константа с цитатой замера, не конфиг.

### Как доказываю поведение
Тесты на реальных фикстурах `createTsProjectHost` (`test/unit/program-gate-builder.test.ts`), оракул — тот же гейт без builder (LS per-file, холодный путь), счётчик работы — шпион `service.getProgram` патчит `getBindAndCheckDiagnostics` каждого нового Program (метод спайка):
- ловушки спайка (passthrough 2 хопа, `export *`-barrel, `declare global` в не-модуль, tombstone с пропущенным импортёром, const enum, non-module script) — introduced-вердикт builder == оракул;
- `assumeChangesOnlyAffectDirectDependencies` → passthrough-ошибка поймана (мутация: снять отказ → красный);
- TS4094 при `declaration:true` поймана (мутация: Semantic-вариант → красный);
- работа: второй гейт с листовой правкой — baseline 0 перепроверок, декой не перепроверен (мутация: всегда без родителя → красный); re-chain после `releaseProgram` не перепроверяет неизменённые;
- post-apply: запись+reindex → `diagnosticsAcross` перепроверяет только записанные (мутация: родитель = disk → замыкание → красный);
- cancel посреди drain → DeadlineExceeded, следующий гейт == оракул.
- `program-gate-cache.test.ts`: тесты per-file baseline удаляются (механизма нет), result-memo остаются на стабах (builders не задан → LS-путь); `program-gate-cache-host.test.ts` — адаптирую.
Живой: скрипт поверх `createTsProjectHost` на `/Users/cody/Dev/amiro` (dry-run, overlay в памяти): холодный гейт / leaf (`lead-main`) / ядро (`form-model`) — счётчик перепроверенных файлов baseline и overlay, вердикт == без builder; `batch [A dry-run, A apply]` на `cp -cR` копии — post-apply перепроверка = записанные; rename на codemaster (declaration) — счётчик.
Гейт: `npm run fix-and-check` + точечно мои тесты + `program-gate-isolation`, `post-apply-verify`, `program-gate-cache*`.

### Ревьюверы кода
bug-reviewer (до 3 кругов по правилу брифа): острие — жизненный цикл builder (чтение после release, продвижение цепочки на throw), симметрия baseline/overlay, отказы по опциям, declaration-parity, cancel; architecture-reviewer на итог (один авторитет, слой, контракт `GateHostCtx`).

### Волна 2 (для менеджера)
t-710809 (инвалидация резолва): builder её не блокирует — смена `referencedMap` (unresolved→resolved) сама кладёт файл в change-set; бамп всех версий = один полный recheck. t-433767 (без force-add в roots): меньше смен root-set → builder-overlay только дешевле, конфликта нет.

Proof-скрипт `scripts/spike/builder-gate/decl.mjs`: Emit-builder даёт LS-parity declaration-диагностики (TS4094) при declaration on/noEmit/composite, инкрементально (codemaster: cold 775 checked, overlay leaf 179, disk←B0 0).


### Довески к DoD (менеджер)
1. Emit-вариант builder не пишет на диск ни байта — writeFile no-op, тест.
2. rename (check=touched) не регрессирует против LS-пути на amiro и на codemaster (declaration:true); регрессирует — rename остаётся на LS-пути.
3. Дифференциальный тест: builder-путь == полный проход на ловушках спайка (+ declaration-вариант) в цепочке disk→overlay→post-apply→disk; негативный контроль assumeChangesOnlyAffectDirectDependencies → путь выключается.


### Правки плана по план-ревью (1 BLOCK, 4 should-fix, 2 nit — все закрыты ниже)
- **[BLOCK] уникальность версии per path.** `loadFileList` (`program/single.ts`) даёт `{version: 1}` файлу, выпавшему из глоба и вернувшемуся (checkout удалил → structural re-glob → checkout вернул с другим телом): builder сравнивает только версию/`referencedMap` и скопировал бы диагностику старого тела. Фикс: `single.ts` помнит последнюю версию выбывших путей (`retired` map), вернувшийся получает `retired+1`; новые — по-прежнему 1, поэтому программы, прошедшие одну последовательность, остаются выровнены в общем `DocumentRegistry` (перекос версий между программами = перепарс-пинг-понг, не ошибка). Попутно закрывает ту же устаревшую версию для самого LS/registry. Комментарий «корректность не зависит от родителя» называет предпосылку: `getScriptVersion` уникален для пути на всю жизнь программы (overlay — монотонный `Overlay.counter`). Тест-ловушка: drop → re-glob → re-add с другим телом и теми же импортами → builder == оракул.
- **[should-fix] порог — одно правило в `pass()`, не только на overlay.** Цена drain — d.ts-emit на каждый изменённый файл при любом родителе (post-apply без `afterGate`, большой дрейф между гейтами, бамп всех версий t-710809). Правило: файлов с версией ≠ родительской > max(50, 10% файлов программы) ⇒ холодный builder без родителя (холодный ≈ LS-full по спайку: 22 vs 28 с). Карта `path→version` хранится в непрозрачном state. Отдельный LS-overlay режим для хаба убран — смешанных режимов внутри программы больше нет.
- **[should-fix] `afterGate` ↔ result-memo.** `afterGate` — LRU(4) per program по точному ключу заявленных этой программой overlay-записей + tombstone; `diagnosticsAcross` получает опциональный `written` (+removed) из `post-apply-verify.ts` и берёт родителя по тому же ключу, иначе `disk`. Порядок `[A dry-run, B dry-run (или impact_type_error), A apply]` — тестом.
- **[should-fix] второй источник.** Пересчёт-перед-отказом через LS `fileDiagnostics` (`uncoveredFiles`) на builder-пути убран: при builder-авторитете он спрашивает тот же LS с тем же резолвом и оставлял бы второй источник истины. На LS-пути (отказ по опциям) кэша нет — пересчитывать нечего. Нормализация: builder-диагностика проходит `ts.sortAndDeduplicateDiagnostics` (LS делает это в `getDiagnosticsHelper`) — одна форма в общем маппере.
- **[should-fix] матрица доказательств дополнена:** родитель = чужой overlay-builder == оракул; порог форсирован (холодный путь) == оракул; ловушка BLOCK; declaration-parity под `noEmit+declaration` и `composite`; Emit-builder ничего не пишет — шпион `writeFile` + пустой `outDir`.
- **[nit]** `module: None` (нет `referencedMap` ⇒ любое изменение = все файлы) — отказ «нет выигрыша». В коде названы: патч `getBuildInfo` на LS-Program, рост `affectedFilesPendingEmit` в Semantic-варианте, удержание overlay-SourceFile в `semanticDiagnosticsPerFile` до следующего гейта — всё ограничено числом файлов.


## Результат и разбор

### Сделано иначе, чем в плане
- **Порог по ширине check-scope** (довесок менеджера №2). Замер `scripts/spike/builder-gate/live.ts`, scope из одного файла: builder медленнее LS — amiro 1.1 с против 0.4 с, codemaster (`declaration:true`) 1.7 с против 0.2 с. Причина: проход builder платит построение состояния по всей программе плюс d.ts-работу изменённых файлов (под declaration — dts-ошибки всего замыкания), ещё до первого чтения. Поэтому builder используется, только когда check-scope ≥ половины файлов программы (move/extract/codemod/transaction). rename и `impact_type_error` остаются на LS-пути. Исключение: post-apply-перепроверка байтов, чей гейт шёл через builder, идёт через builder на любом scope — она продвигает цепочку, с которой стартует baseline следующего гейта. После правки: rename 0.5 с против 0.4 с (amiro) и 0.2 против 0.2 (codemaster).
- **`releaseProgram` и `SourceFile.version` оказались `@internal`**, хотя отчёт спайка называл их публичными. Оба читаются через один типизированный блок в `program-gate-builder.ts`. `releaseProgram` проверяется пробой: без него builder-путь выключается.
- **Проба internals** обязана ставить `sf.version`: TS assert'ит «Program intended to be used with Builder should have source files with versions set». Первая версия пробы падала молча, и весь builder-путь был выключен. Тесты на равенство с оракулом при этом проходили — оба пути были LS. Поймали это только тесты на счётчик работы.

### Факты о системе
- **Штраф первого перехода — навсегда для файлов, которые не меняются на диске.** Холодное состояние хранит версии вместо d.ts-сигнатур, а дисковая цепочка не пересчитывает сигнатуру файла, пока он не изменился на диске. Поэтому каждая overlay-правка такого файла инвалидирует всё его замыкание даже при правке комментария. Замер amiro, `form-model.ts`: 2191 перепроверка и при повторе. Реальная сигнатура появляется только после записи через post-apply. Ловушка `assumeChangesOnlyAffectDirectDependencies` в тесте поэтому сначала записывает benign-правку на диск — иначе она проходила бы по чужой причине.
- **Чекер опрашивает токен отмены только на function-like узлах** — тест отмены обязан содержать функцию.
- **LS проверяет файлы через внутренности Program (`getBindAndCheckDiagnosticsForFile`), а не через метод-свойство.** Шпион на `getBindAndCheckDiagnostics` видит только проходы builder. Отсюда тест «узкий scope → LS» читает пустой лог как «builder не запускался».

### Живые замеры (CPU шумный, работа — счётчиком перепроверенных файлов)
- amiro, 3796 файлов, overlay в памяти: холодный гейт 27–28 с (baseline 3800, overlay 1); повтор leaf 0.7 с (0 / 1); правка в ядре 13–17 с (0 / 2191); полный LS-гейт 51 с. Вердикт builder == LS (baseline и overlay).
- codemaster, 456 файлов, `declaration:true`: холодный 7.9 с; leaf 2.4 с (0 / 180); ядро 3.0 с (0 / 326); полный LS 5.8 с. Вердикт совпал.
- Apply на APFS-клоне amiro, batch `[move_symbol blankToNull→src/lib/form-field.ts dry-run, тот же apply]`: dry-run 49.9 с, apply 5.5 с (memo + post-apply через builder), `typecheck=clean`, отката нет. Клон удалён.

### Что не покрыто / осталось
- Транзакции и частичный прогресс после отмены не замерены. Прерванный проход выбрасывается целиком, родитель остаётся — по построению, без отдельного теста.
- Хаб-правка на amiro (сотни изменённых файлов) вживую не прогонялась. Холодный рестарт цепочки покрыт тестом с 60 файлами.
