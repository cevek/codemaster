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
