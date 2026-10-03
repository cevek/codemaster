---
id: t-932492
title: 'transaction: extract_symbol+move_symbol в один dest для потребителя с namespace-импортом (import * as M) плодит дубли namespace-импорта dest и ссылки <dest>_N'
status: in-progress
priority: high
parent: t-116306
tags:
  - mutation
  - transaction
type: bug
complexity: M
area: transaction
evidence: repro
author: f0182919
created: '2026-10-03T15:44:48.549Z'
---
## Repro (эталон /Users/cody/Dev/amiro @ d89515259, dry-run, codemaster 41f6c70)

`node src/bin.ts op transaction "$(cat chain8.json)" --root /Users/cody/Dev/amiro` — цепочка: `extract_symbol setNameTranslation` из `src/features/settings/forms/forms-builder-model.ts` в новый `src/features/settings/forms/forms-builder-i18n.ts`, затем 7× `move_symbol` (setDescriptionTranslation, setSectionTitle, setSectionDescription, setQuestionLabel, setQuestionHint, setQuestionPlaceholder, setFieldId) в тот же dest. Аргументы цепочки — в теле t-749107 (раздел замера).

Потребитель `src/features/settings/forms/FormBuilder/use-form-builder.ts` импортирует модель как `import * as M from '../forms-builder-model.ts'` и зовёт `M.setX(...)`.

Итог: гейт `clean=false`, 15 introduced — 8× `Duplicate identifier 'formsBuilderI18n'` (восемь строк namespace-импорта dest, по одной на шаг) и `Cannot find name 'formsBuilderI18n_2'…'_7'` в местах вызова.

Гейт отказал честно (не ложь), но цепочка неисполнима: каждый шаг добавляет свой namespace-импорт dest вместо переиспользования добавленного предыдущим шагом, а ссылки получают суффикс `_N`, которого нет ни в одном импорте.

Не проверено: воспроизводится ли на одиночном `move_symbol` (без transaction) в dest, который потребитель уже импортирует namespace-импортом — это отделит поведение LS «Move to file» от склейки оверлея в `TxnCompose` (`ops/transaction-compose.ts`) и нормализатора `foldSameModuleImports` (`plugins/ts/refactor/normalize/fold-imports.ts`).


## Разбор (инвентаризация)

Диагноз постановки опровергнут: дефект НЕ в склейке транзакции. Одиночный `move_symbol` (extract применён на диск, затем move в тот же dest, без transaction) даёт тот же `Duplicate identifier 'i18n'` + `Cannot find name 'i18n_1'`. `TxnCompose` (`ops/transaction-compose.ts`) и `foldSameModuleImports` ни при чём: fold работает только по dest и пропускает namespace-группы, а consumer-файлы не трогает вовсе. Транзакция лишь мультиплицирует: каждый шаг видит импорт предыдущего как занятое имя.

Корень — апстрим TS 6.0.3, `updateNamespaceLikeImport` (lib/typescript.js, рефактор Move to file / Move to new file): (1) считает `needUniqueName` через `checker.resolveName(preferred, ref)`, рефы переписывает в `getUniqueName(preferred)` (`i18n_1`), а импорт вставляет с `preferredNewNamespaceName` (`i18n`) — имена расходятся всегда, когда предпочитаемое занято; (2) не ищет существующий namespace-импорт dest в consumer — всегда вставляет новый.

Прогнано (фикстуры `/tmp/ns932inv/run.mjs`, consumer `import * as M from '../model.ts'`, вызовы `M.setX`):
- (a) consumer уже `import * as i18n from <dest>` (одиночный move и цепочка extract+2×move) → дубль импорта + `i18n_N`, гейт refuse.
- (b) предпочитаемое имя занято несвязанным локалом: top-level `const i18n` / параметр `i18n` в месте вызова (одиночный extract) → импорт `i18n`, рефы `i18n_1`, гейт refuse.
- (c) consumer уже `import * as I from <dest>` под ДРУГИМ alias → typecheck-clean, но второй namespace-импорт того же модуля (`i18n`) рядом с `I` — молчаливый дубль, гейт пропускает.
- (a') как (a), но в месте вызова параметр `i18n` затеняет существующий alias → дубль + `i18n_1`, refuse.
- Чисто: rename_symbol (`M.setName`→`M.withName`), change_signature reorder на `M.setName(...)`, move_file (спецификатор ns-импорта переписан).
- Вне скоупа (другой механизм, отдельные таски): dest сам ns-импортирует source и зовёт перенесённый символ через `M.x`; type-позиционные рефы `M.Model` / `typeof M.setName` (QualifiedName — LS фильтрует только PropertyAccess); `export * as M` барьер (документированный отказ move_symbol, таски не нужно); namespace+named пара одного модуля — t-000094.

## План

**Скоуп:** новый модуль `src/plugins/ts/refactor/imports/reconcile-namespace-import.ts` — правка LS-ответа (`ts.FileTextChanges[]`) ДО применения к дереву, подключается в обоих потребителях шва: `refactor/extract/move-to-existing.ts` (move_symbol) и `refactor/extract/move-to-file.ts` (extract_symbol). `transaction-compose.ts`, `fold-imports.ts`, файлы гейта (`program-gate*`, `single.ts`, `diagnostics.ts`) не трогаю.

**Подход** — источник правды `fc.textChanges` + чекер ДО-правочной программы (той, на которой LS посчитал правки; в шаге транзакции — с оверлеем):
1. В каждом не-dest `fc` найти вставку (span.length 0), чей newText парсится в ровно один `import * as P from '<spec>'`, и замены рефов: span точно покрывает Identifier, родитель — PropertyAccessExpression с этим идентификатором в `.expression`, newText — идентификатор `Y` (`P` или `P_N`). Нет такой пары — fc без изменений (байт-в-байт).
2. Существующий ns-импорт dest в consumer: ImportDeclaration с NamespaceImport, чей `moduleSpecifier` чекер резолвит в модуль с файлом === dest abs (резолв, не текст: кавычки/`.ts` различаются). Берётся первый, alias `K`.
3. (a)/(c): `K` есть и в КАЖДОМ месте рефа `checker.resolveName(K, ref, Value|Namespace|Alias, false)` возвращает символ этого импорта (не затенён) → рефы переписываются в `K`, вставка удаляется.
4. Иначе ((b), (a')) → если `Y ≠ P`, имя во вставке заменяется на `Y` (getUniqueName уже гарантирует уникальность по файлу) — импорт и рефы сходятся; (a') даёт законный второй alias того же модуля.
5. `import X = require()` / `const X = require()` формы (тот же LS-путь) не трогаются — гейт остаётся бэкстопом; строка в разбор.

**Развилки:** (i) правка edit-уровня до применения vs текстовый нормализатор после (как fold/strip-self): выбран edit-уровень — только там видно, какие идентификаторы LS переписал (после применения `i18n_1` неотличим от пользовательского имени) и доступен до-правочный чекер для проверки затенения; (ii) переиспользовать существующий alias vs оставить второй импорт с согласованным именем: переиспользование — то, что сделал бы человек, и что сходит цепочку; отказ от него только при доказанном затенении.

**Доказательство поведения:** e2e на инлайн `project()` (стиль `test/e2e/transaction-move-symbol.test.ts`), оракул — `coldDiagnostics` пост-дерева после apply + структурный ассерт на consumer (ровно один ns-импорт, резолвящийся в dest, ноль идентификаторов `<alias>_N`):
- одиночный `move_symbol` в dest, который consumer уже ns-импортирует (a) — дискриминирующий, опровергает постановку;
- одиночный `extract_symbol` с затеняющим параметром (b) — импорт и рефы на одном имени;
- (c) другой alias → рефы на `I`, второго импорта нет;
- (a') затенённый alias → не переписан в затенённое имя, cold-компиляция чистая;
- цепочка extract+2×move в transaction → clean, `transaction-compose` не менялся (интеграция).
До фикса (a),(b),(a') красные (`clean=false`), (c) красный по структурному ассерту — показать мутацией (выключить нормализатор). Живая проверка: dry-run цепочки t-749107 против `/Users/cody/Dev/amiro` (только чтение).

**Ревьюверы на код:** bug-reviewer (до двух кругов по правилу брифа).


Вне скоупа заведено: t-698933 (type-позиционные namespace-рефы), t-647916 (dest сам ns-импортирует source).
