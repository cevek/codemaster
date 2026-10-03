---
id: t-749107
title: 'план мутации делает ненужную работу на каждом шаге: rewriteImports парсит и резолвит всё дерево без единого перемещения, planUnderOverlay пересобирает дисковую программу ради опций'
status: in-progress
priority: medium
parent: t-116306
tags:
  - mutation
  - perf
  - transaction
type: perf
complexity: M
evidence: measured
author: fad2132f
created: '2026-10-03T13:35:30.479Z'
---
Контекст — эпик t-713045 (латентность мутаций). После typecheck-гейта следующее узкое место шага мутации — план (`planUnderOverlay` в `plugins/ts/plugin-helpers.ts` → `assemblePlan` → `rewriteImports` в `plugins/ts/refactor/imports/`).

## Проблема

- `rewriteImports` на КАЖДОМ вызове парсит все TS-файлы дерева и резолвит каждый спецификатор (`ts.resolveModuleName(…, ts.sys)` без кэша), даже когда в дереве нет ни одного перемещённого узла — а без перемещения правок не бывает по построению. Это все шаги `extract_symbol` / `move_symbol` / `change_signature` (content-only дерево), одиночные и в `transaction`: ≈2.4 с/шаг, 18 % 8-шаговой цепочки на эталоне.
- `planUnderOverlay` читает `getCompilerOptions()` до `setOverlay`, поэтому на каждом шаге ≥1 транзакции пересобирает дисковую программу, которую тут же сменяет overlay-программа: ≈1 с/шаг, 8 %.
- Кэш разбора по цепочке (исходная гипотеза) — не лекарство: SourceFile'ы по тексту уже переиспользует DocumentRegistry, основная цена — работа, которая не нужна вовсе. Замеры — ниже.


## Замер (2026-10-03)

Метод: `node --cpu-prof src/bin.ts op transaction '<chain>' --root /Users/cody/Dev/amiro` — CLI one-shot (включает холодный прогрев), dry-run, amiro @ d89515259, codemaster 41f6c70 (после t-786607/t-439159). Бакеты — inclusive-время по имени функции в стеке (скрипт агрегирует сэмплы `.cpuprofile`; каждый сэмпл засчитывается функции один раз). Машина шумная (load 10–71) — сравнивать ДОЛИ, не секунды.

Цепочка A (8 шагов, форма логированных цепочек `pl-a-audit`/`et-b-note-builder`): `extract_symbol setNameTranslation` из `src/features/settings/forms/forms-builder-model.ts` → `src/features/settings/forms/forms-builder-i18n.ts`, затем 7× `move_symbol` в тот же dest (setDescriptionTranslation, setSectionTitle, setSectionDescription, setQuestionLabel, setQuestionHint, setQuestionPlaceholder, setFieldId).
Цепочка B (4× `move_file`): `deletion-confirm.ts`, `deletion-loss.ts`, `issue-slots.ts`, `forms-group.ts` из `src/features/settings/forms/` в `src/features/settings/forms/model/`.

Wall-clock: A — 110.6 / 99.4 / 88.1 с real (user 112.5 / 100.1 / 99.4; load 46 / 71 / 28); B — 91.1 с real (load 10).

| бакет | A (профиль 108.7 с) | B (профиль 89.6 с) |
|---|---|---|
| `gateAcross` (почти всё — `getSemanticDiagnostics`) | 46.2 с · 43 % | 48.2 с · 54 % |
| `rewriteImports` | 19.1 с · 18 % (≈2.4 с/шаг) | 10.0 с · 11 % (≈2.5 с/шаг) |
| `getProgram` в `planUnderOverlay` ДО `setOverlay` | 8.3 с · 8 % | 4.5 с · 5 % |
| прочее тело планировщиков (LS-refactor, captures, overlay-сборка) | ≈8 с | ≈7 с |
| GC (размазан) | 16.5 с | 14.2 с |

Факты, вскрытые профилем:
- **Для `extract_symbol`/`move_symbol`/`change_signature` `rewriteImports` — no-op по результату, но не по цене.** Их дерево content-only: ни один узел не перемещается (extract создаёт синтетический файл сразу в dest, initial == current; move_symbol и change_signature только `setContent`). Правка в `rewriteImports` эмитится лишь под `targetMoved || importerMoved` (оба — сравнения `currentPath()`/`initialPath()`), значит при нуле перемещений вызов даёт ноль правок и ноль `rewrites` — но каждый раз парсит все ≈3.5k файлов (`createSourceFile`, 6.5 с из 19) и резолвит каждый спецификатор через `ts.resolveModuleName(…, ts.sys)` без кэша (12.3 с: `stat`/`realpath`/`open`/`tryParseJson` по node_modules). Комментарии в `planExtractTo` (`move-to-file.ts`) и `planMoveSymbolTo` (`move-to-existing.ts`) уже называют вызов no-op.
- **`planUnderOverlay` (`plugin-helpers.ts`) на каждом шаге ≥1 пересобирает ДИСКОВУЮ программу только ради `getCompilerOptions()`**: опции читаются после `clearOverlay` прошлого шага и до `setOverlay` текущего → `synchronizeHostData` на диск, а тело шага тут же собирает overlay-программу. Линейная оценка по двум цепочкам: ≈1 с на шаг ≥1 (холодная сборка шага 0 ≈1.7 с — она нужна в любом случае).
- **Для `move_file` `rewriteImports` — настоящая работа.** Внутри ≈2.5 с/шаг: резолв 1.06 с/шаг (`resolveSpecifierToNode` 4.24 с / 4), парс 0.75 с/шаг, overlay-сборка программы 0.5 с/шаг (случится в любом случае).
- Посылка таски («кэшировать парсинг по цепочке») опровергнута как лекарство: SourceFile'ы по тексту уже переиспользует DocumentRegistry программы, второй кэш парсинга избыточен; основная цена — работа, которая не нужна вовсе.

## План

Трек переформулирован: **не кэшировать, а не делать ненужное** — два пункта, оба для всех потребителей (одиночные ops тоже, не только transaction).

1. **Гард no-move в `rewriteImports`** (`plugins/ts/refactor/imports/rewrite.ts`): если в дереве нет узла с `currentPath() !== initialPath()` — сразу вернуть пустые `changed`/`rewrites` (до `deriveAliasPrefixes`/`getProgram`/парса). Проверка — по ПУТЯМ, не по именам: перенос каталога двигает детей через родительскую цепочку, имена детей не меняются. Предикат — метод `VFSTree.hasMoves()` (`refactor/tree/tree.ts`) по всем узлам (файлы и каталоги): каталог-цель резолва (`findByInitialPath(baseAbs)`) тоже покрыт без отдельного рассуждения. Стоимость — O(узлов × глубина) обходов родителей, мс. Комментарии «no-op» в `planExtractTo`/`planMoveSymbolTo` становятся точными.
2. **Опции без дисковой пересборки** в `planUnderOverlay` (`plugins/ts/plugin-helpers.ts`): читать `getCompilerOptions()` ВНУТРИ `runWithOverlay` (после `setOverlay`) — overlay не меняет compilerOptions, а overlay-программу тело шага строит всё равно. Для `overlay === undefined` (шаг 0 / одиночный op) поведение байт-в-байт прежнее. `program/single.ts` не трогаю (трек t-378508).

Проверка поведения:
- Корректность п.1 — существующие оракулы перемещения: `test/e2e/kitchensink-move.test.ts` (перенос КАТАЛОГА `src/features/widget`), `test/e2e/move-file.test.ts`, `test/e2e/transaction*.test.ts`. Мутационная проверка: гард по именам (`currentName !== initialName`) обязан покрасить тест переноса каталога — увидеть красным; если не красит, добавить ассерт на переписанный спецификатор файла внутри каталога. Отдельный тест на «гард сработал» не пишу: дефект «гард не сработал» — перф, не тихая ложь; дефект «гард сработал зря» ловят оракулы перемещения.
- Корректность п.2 — `test/e2e/transaction.test.ts` и `transaction-cross-program.test.ts` (шаги ≥1 планируются под overlay).
- Эффект — та же цепочка A и B под `--cpu-prof`: бакет `rewriteImports` на A 19 с → ≈0, `getProgram` в `planUnderOverlay` 8.3 с → ≈холодная сборка; плюс wall-clock с разбросом (3 прогона).
- `npm run fix-and-check`, точечно `node --test` по файлам выше.

Ревью кода: bug-reviewer (один круг; второй — только при `[BLOCK]` > 1).

### Под чертой (не в треке, с цифрами)
- `ts.createModuleResolutionCache` на время одного вызова `rewriteImports` для `move_file`: резолв 1.06 с/шаг из ≈22 с шага (≈5 %), выигрыш оценочно ≈0.7 с/шаг — не стоит трека.
- Переиспользование program-SourceFile вместо `createSourceFile(…, ScriptKind.TSX)`: смена поведения (TSX-парс `.ts`), не перф.
- `detectReverseImportCaptures` 2.5 с на цепочке B (≈0.6 с/шаг) — не разбирал.
- Остальное время — гейт (43–54 %), трек t-378508.


### Поправки по plan-ревью (один круг, блокеров нет)
- Мутант «гард по именам» в `kitchensink-move.test.ts` убивает ПЕРВЫЙ тест (`src/lib/util.ts` → `src/helpers/util.ts`: имя файла то же, `helpers` — синтетический каталог), а не тест каталога (`widget` → `card` — это переименование, имя меняется). Непокрытая форма — перенос каталога под другого родителя без смены имени (`src/a/widget` → `src/b/widget`). Фикстуру под неё не добавляю: пропущенная из-за неверного гарда перепись импорта оставляет висящий спецификатор, который ловит §2.8-гейт, — дефект громкий, не тихий. Предикат — сравнение путей, у которого этой дыры нет по построению.
- Метрика «после» для п.2 — inclusive `createProgram`/`synchronizeHostData` по всему профилю (число сборок на шаг ≥1: две → одна), не бакет по кадру `planUnderOverlay` (кадр уедет вместе с вызовом).
- Док-комментарий `planUnderOverlay` (`PlanningHelpers`) обновить в том же диффе.
- Мёртвый `VFSTree.rekeyByInitialPath` — вне скоупа, отдельная таска.


## Результат

Метод — тот же, что в «Замер»: `node --cpu-prof src/bin.ts op transaction …`, amiro @ d89515259, dry-run; «после» — 81b8596. Load при «после» 6–9 против 10–71 при «до», поэтому wall-clock не сравним напрямую — дискриминирует бакет профиля.

| бакет | A до → после | B до → после |
|---|---|---|
| `rewriteImports` | 19.05 → 0.03 с | 10.0 → 7.9 с (настоящая работа, не трогалась; разница — шум) |
| `createProgram` inclusive (число сборок) | 15.8 → 9.0 с (−7 дисковых пересборок, ≈1 с каждая) | 7.6 → 6.3 с (−3) |
| `planUnderOverlay` | 36.4 → 10.9 с | 17.4 → 16.3 с |
| `gateAcross` | 46.2 → 43.8 с | 48.2 → 48.4 с |

Wall-clock «после»: A 73.1 (под профилем) / 65.8 / 64.4 с real, user 84.8 / 77.5 / 76.0; B 86.5 с. Вывод op (dry-run) байт-в-байт совпал с «до» на обеих цепочках.

Мутационная проверка гарда: `hasMoves()` по именам (`currentName !== initialName`) красит 7 тестов `move-file.test.ts` / `kitchensink-move.test.ts`; гард по путям — зелёные. Мутант «гард всегда true» эквивалентен исходнику, дискриминировать нечего.

Для цепочки из extract/move_symbol план теперь ≈1.4 с/шаг; остаток шага — гейт (≈60 % после правки, трек t-378508). Для move_file план остаётся ≈4 с/шаг, из них `rewriteImports` ≈2 с — следующий рычаг там резолв-кэш (под чертой в плане).
