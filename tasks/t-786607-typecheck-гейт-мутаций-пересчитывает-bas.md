---
id: t-786607
title: typecheck-гейт мутаций пересчитывает baseline-диагностику всей программы на каждом вызове — кэшировать по дисковой версии программы
status: review
priority: high
parent: t-713045
tags:
  - cache
  - gate
  - mutation
  - perf
type: perf
complexity: M
evidence: measured
author: fad2132f
assignee: 4719392d
created: '2026-10-03T13:35:18.321Z'
---
Контекст и замеры — эпик t-713045.

## Проблема

`gateAcross` (`plugins/ts/program-gate.ts`) на каждом move/extract/codemod/transaction считает baseline (диск) по всей программе ≈20 с на эталонном репо, хотя это чистая функция дискового состояния. `SingleProgram.version` (`program/single.ts`) один и бампается и reindex'ом, и `setOverlay`/`clearOverlay` — поэтому ключевать кэш по нему нельзя.

## Решённое направление (менеджер; детали — твой план)

- Отдельная «дисковая» версия на программу (меняется только reindex/loadFileList и §3.5-дрейфом); кэш baseline `TsDiagnostic[]` per program по полному file-set, фильтр до `checkAbs` при использовании — симметрия baseline/overlay (инварианты 1–2 в шапке `program-gate.ts`) сохраняется. Cancelled/partial сбор не кэшируется.
- Кэш overlay-результата по ключу `дисковая версия ⊕ hash(overlayFiles, removed, checkAbs)` — apply после идентичного dry-run пропускает гейт.
- Дрейф, который LS сам не видит (`node_modules`/lockfile/`package.json`/`.d.ts`, `extends` с не-tsconfig basename) — инвалидировать; решить в плане, как именно.
- §3.1 (кэш только с жёсткой инвалидацией), §16 cold == warm — обязательны.

Гипотеза, не рамка: опровергнешь посылку по коду — доложи.


## План

### Посылки, проверенные по коду
- `SingleProgram.version` (`program/single.ts`) — это `getProjectVersion` LS + вклад в `host.projectVersion()`/freshness; бампается reindex'ом, `loadFileList`, `setOverlay`/`clearOverlay`/`withMergedOverlay`. Его НЕ трогаю.
- Дисковый вид LS = f(версии в `files` map, результаты резолва модулей при сборке Program). Версия файла в `files` меняется только в `reindex`/`loadFileList`; нетрекаемые файлы (node_modules, вне глоба) всегда версии `"1"` → их правки LS не видит ни в baseline, ни в overlay (симметрично, существующее поведение). Единственное, что overlay-проход видит, а закэшированный baseline нет, — смена РЕЗОЛВА (появился/исчез пакет) между гейтами.
- Всё, что видит git (package.json, lockfile, `.d.ts` вне глобов, `extends: ./base.json`), приходит в `reindex(changed)` через §3.5-проверку на входе op → любой reindex бампает дисковую версию, перечислять триггеры не нужно.
- В момент `gateAcross` overlay ни у одной программы не активен (transaction гейтит собранный план после шагов; шаги используют `withMergedOverlay` scoped). Но гейт внутри активного overlay сделал бы «baseline» не дисковым → кэш обязан обходиться при активном overlay.
- `introducedDiagnostics` = multiset `overlay − baseline`: устаревший baseline с ЛИШНЕЙ ошибкой может поглотить внесённую (ложный clean), с НЕДОСТАЮЩЕЙ — ложный отказ. Отсюда жёсткость ключа.

### Подход
1. `program/single.ts`: `diskVersion()` — счётчик, бампается в `loadFileList` и в КАЖДОМ `reindex` (не только structural); overlay-методы его не трогают. `overlayActive()` — overlay непуст (Overlay уже знает размер/ключи). Больше single.ts не трогаю (у капа 300).
2. Новый `plugins/ts/program-gate-cache.ts` (хост-уровень, создаётся ОДИН раз в замыкании `createTsProjectHost`, передаётся в `GateHostCtx.cache?` — `gateCtx()` строит ctx заново на каждый вызов, поэтому кэш живёт снаружи):
   - **baseline per program, per file**: `WeakMap<SingleProgram, {stamp, files: Map<abs, TsDiagnostic[] | ABSENT>}>`. Генерация валидна, пока `diskVersion` и install-stamp те же; иначе сбрасывается целиком. Файл кладётся в map только ПОСЛЕ возврата его syntactic+semantic (отмена посреди файла → он не записан, уже собранные — полные и валидны). Промах → считаем только недостающие файлы в порядке `checkAbs`. Если все файлы в кэше — `service.getProgram()` для baseline не зовётся.
   - **overlay-result**: LRU на 4 записи. Ключ — точная строка (не FNV: 32-битная коллизия = ложный clean): affected-программы по идентичности объекта + `diskVersion` каждой + install-stamp + отсортированные `(abs, content)` + `removed` + `checkAbs` + `anchor`. Значение — полный `GateResult` (отдаётся копиями массивов). Не кэшируется результат с непустым `degraded` (отмена в sibling'е сейчас ловится как degraded — транзиентно) и любой брошенный гейт.
   - **install-stamp**: для root и `configDir` каждой affected-программы — подъём до корня ФС, на каждом уровне `stat` `node_modules` (mtime) + маркеров `node_modules/.package-lock.json`, `.modules.yaml`, `.yarn-state.yml`, `.yarn-integrity` (mtime+size, отсутствие = отдельное значение). Ограничено глубиной пути × 5 stat, без обхода дерева.
   - Обход кэша: `program.overlayActive()` → считаем как сейчас и не пишем.
3. `program-gate.ts`: baseline-ветка `gateAcross` идёт через кэш, если `ctx.cache` задан; иначе — как сейчас (существующие stub-тесты не меняются). `diagnosticsAcross` (post-apply, трек t-439159) НЕ трогаю.
4. `diagnostics.ts`: выделить per-file сборщик из `collectFromService` (аддитивно, `collectFromService` поверх него — байт-в-байт тот же вывод).
5. `ls-host.ts`: создать кэш, передать в `gateCtx`. +2 строки.

### Развилки
- **Где кэш**: в хост-уровневом модуле гейта, ключ на `program.diskVersion()`, а не внутри `SingleProgram`. Почему: (а) single.ts на капе 300 строк; (б) `SingleProgram → diagnostics.ts → (type) ls-host.ts → single.ts` — цикл; (в) владелец инвалидации всё равно SingleProgram (`diskVersion`/`overlayActive` — его приватное состояние, наружу только чтение); (г) тестируется детерминированно stub-программами со счётчиком вызовов LS.
- **Гранулярность per-file, а не «весь file-set с фильтром»**: rename гейтит `check = touched`; монолитный full-set заставил бы его платить ~20 с, которых он сейчас не платит. Per-file одной структурой обслуживает rename и move/extract/codemod/transaction. Цена: baseline файла A может быть посчитан в другом checker-прогоне, чем B; у TS порядок проверки влияет на редкие circularity-диагностики — тот же класс, что внутри одного Program у самого TS (его per-file кэш тоже зависит от порядка запросов). Принимаю, называю.
- **node_modules**: брифу нужна инвалидация, advisor предлагал residual. Выбираю дешёвые install-маркеры (константное число stat) — ловят install/uninstall/add, т.е. реальное событие между гейтами. Остаток (удаление резолвнутого gitignored-файла без install — `rm -rf packages/x/dist`; ручная правка `package.json` внутри node_modules) → backlog-таска residual: даёт ложный отказ (не ложный clean, кроме совпадения ключа file:line:message).
- **Отмена**: «cancelled не кэшируется» на уровне файла: прерванный файл не записан; полностью посчитанные до отмены — пишутся (они полные).

### Как доказываю поведение
Unit (stub-программы, `test/unit/program-gate-cache.test.ts`), каждый обязан краснеть на мутации:
- (i) второй гейт с другим overlay → 0 вызовов `getSemanticDiagnostics` на baseline; идентичный overlay → 0 вызовов вообще (мутация: ключ без кэша → красный).
- (ii) ключ различает контент: тот же путь, другой content → overlay пересчитан (мутация: ключ без content → красный).
- (iii) бамп `diskVersion` → baseline пересчитан (мутация: убрать сравнение версии → красный).
- (iv) throw посреди baseline-сбора → следующий вызов досчитывает прерванный файл (мутация: писать `[]` в catch → красный).
- (v) `overlayActive()` → кэш не читается и не пишется.
- (vi) `degraded` непуст → overlay-result не кэшируется.
Real-fixture (temp dir, `createTsProjectHost`): 
- `reindex(['x.ts'])` после правки диска бампает `diskVersion`, `setOverlay`/`clearOverlay` — нет; `reindex(['package.json'])` — бампает.
- cold == warm через гейт: правка диска + reindex → warm-baseline == baseline свежего хоста.
- install-stamp: импорт `foo` без пакета → baseline с «Cannot find module»; создать `node_modules/foo` без reindex → warm == cold (мутация: выкинуть stamp → красный).
Живой: `/Users/cody/Dev/amiro`, CLI `batch` одним процессом `[A, A, B]` (A = move_symbol blankToNull→src/lib/form-field.ts, B = extract_symbol blankToNull→src/lib/blank-null.ts), dry-run, `CODEMASTER_DEBUG=op:*` `ms=` по каждому. ДО (base 59d6791, параллельно идут замеры двух других треков): A1 66.3 с, A2 49.5 с. Ожидание ПОСЛЕ: A2 ≈ время плана (~5 с, гейт пропущен целиком), B ≈ −20 с от ДО (baseline из кэша; сборка disk-Program через `owns()`→`containsFile` остаётся — секунды). Apply: `cp -cR /Users/cody/Dev/amiro /tmp/gbc-amiro`, batch `[A dry-run, A apply]` — apply без гейта; post-apply — трек t-439159.
Гейт: `npm run fix-and-check` + точечный `node --test` моих файлов + `test/unit/program-gate-isolation.test.ts`.

### Ревьюверы кода
bug-reviewer (обязательно): острие — полнота ключа (всё, от чего зависит дисковый вид LS), симметрия baseline/overlay, отмена, гейт внутри overlay.

### Кросс-трек
Post-apply `diagnosticsAcross` (t-439159) после записи считает дисковые диагностики на НОВОЙ версии — мог бы заполнять per-file кэш для следующего op. Это контракт → решение менеджера, не делаю.


### Правки плана по план-ревью (вердикт: BLOCK нет, 6 should-fix, 3 nit — все закрыты ниже)
- **ls-host.ts на капе (297/300)**: фабрика `createGateCache` экспортируется из `program-gate-cache.ts`, импорт — в существующий `import … from './program-gate.ts'` нет: в отдельный, итого +2 строки (импорт + `const gateCache`), `cache: gateCache` — в существующую однострочную `gateCtx`. Не влезает после prettier → `gateCtx` уезжает в `program-gate-cache.ts` фабрикой.
- **Вложенные node_modules + нет рычага при устаревшем кэше → закрываю классом, а не stamp'ом**: кэш ускоряет только CLEAN-путь. Если overlay содержит диагностику, не покрытую baseline'ом (multiset по file|line|message — тот же ключ, что `introducedDiagnostics`), а хоть один baseline-файл пришёл из кэша — baseline этих программ пересчитывается БЕЗ кэша (и кэш перезаписывается свежим) до возврата. Итог: устаревший кэш физически не может дать ложный ОТКАЗ (ни `rm -rf dist`, ни install во вложенном `packages/y/node_modules`) — агенту рычаг не нужен. Цена — пересчёт baseline только на пути «есть кандидаты во introduced» (moved-file ремап в `refactor-plan-apply` делает наивный diff шире реального — лишний пересчёт, не ошибка). Ложный CLEAN от устаревшего кэша требует, чтобы устаревший baseline содержал ошибку, которой на диске больше нет, И правка внесла ровно её же (тот же file:line:message) — остаток только в гитигнорной области, называю в residual-таске. Install-stamp остаётся (дёшев, снимает и это для install/uninstall), расширен на `configDir` ВСЕХ built-программ (members), не только affected.
- **Тесты ключа overlay-кэша**: параметризованный тест — по одному случаю на каждый компонент ключа (content, removed, check, anchor, diskVersion любой affected-программы, install-stamp, идентичность программы): изменение компонента → промах (счётчик LS-вызовов > 0).
- **Доки (present-state)**: ARCHITECTURE §3.1 — третий санкционированный кэш и его authority (diskVersion ⊕ install-stamp, обход при активном overlay, пересчёт перед отказом); §7 — строка «apply после идентичного dry-run переиспользует результат гейта»; §15 + `src/README.md` — новый файл.
- **Механизм в живом замере**: в плагин `debug` не проброшен — тащить его ради лога = расширение скоупа. Вместо этого: (а) end-to-end `batch [A,A,B]` по `ms=` как в «до»; (б) скрипт поверх `createTsProjectHost` на `/Users/cody/Dev/amiro`, зовущий `host.gateAcross` с overlay из A трижды (A, A, B) и считающий вызовы `getSemanticDiagnostics` шпионом на `service` — даёт hit/miss напрямую, независимо от нагрузки соседей. Плюс real-fixture тест: два гейта через `createTsProjectHost` БЕЗ reindex между ними → второй baseline из кэша.
- nit: убран ложный довод «single.ts на капе» (220 строк кода; решение держится на цикле импортов и тестируемости); stamp — свой `statSync` (нужен mtime КАТАЛОГА `node_modules`, `support/fs/stat-fingerprint` берёт только файлы по repo-rel пути); `overlayActive()` проверяется до `overlayCollect`.
- Замер ДО на `/Users/cody/Dev/amiro` (base 59d6791, одним процессом, параллельно 2 трека): A1 64.3 с, A2 73.2 с, B 78.3 с; все три `typecheck=clean`. Шум нагрузки ±15 с — поэтому (б).


## Результат и разбор

### Расхождения с планом (сделано иначе — и почему)
- **install-stamp удалён.** Проба показала: TS LS при пересборке Program переиспользует резолв модулей неизменённых файлов (structure reuse; `hasInvalidatedResolutions` у нашего `LanguageServiceHost` нет). После `pnpm add foo` тёплый LS продолжает видеть `Cannot find module 'foo'` и в baseline, и в overlay-проходе, и после `clearOverlay` — свежий хост ошибки не видит. Значит stamp ничего не делал бы симметричнее: кэш не может быть свежее самого LS. Это существующая слепота тёплого LS → **t-710809** (repro). Посылка плана «каждый гейт строит свежий Program и переразрешает модули» — ОПРОВЕРГНУТА.
- Резолв перезапускается для файла с новым SourceFile и для ВСЕЙ программы при смене набора корневых файлов (каждый move/extract overlay: dest + tombstone, и его откат) — так дисковый вид при одном `diskVersion` становится history-dependent. Защита: **пересчёт перед отказом** — каждый закэшированный файл, где overlay даёт непокрытую диагностику (multiset file|line|message), и каждый tombstone-путь (ops ремапят baseline старого пути на dest) пересчитываются с диска до возврата. Ложного отказа из кэша нет; остаточный ложный clean (совпадение ключа в gitignored-области) → **t-828499**.
- `anchor` не входит в ключ результата: он целиком выводится в набор affected-программ, чьи id и `diskVersion` в ключе есть.
- Результаты, чья программа ушла с `diskVersion`, выбрасываются при каждом обращении; ключ > 4 М символов не кэшируется (whole-tree codemod).

### Живой замер, /Users/cody/Dev/amiro (3797 файлов в программе), CPU делят параллельные треки
- batch [A, A, B] одним процессом (A = move_symbol blankToNull→src/lib/form-field.ts, B = extract_symbol blankToNull→src/lib/blank-null.ts), dry-run, `ms=` из `op:*`. ДО (59d6791): 64.3 / 73.2 / 78.3 с. ПОСЛЕ (3664960): 68.8 / **9.6** / 57.4 с. Вывод всех трёх побайтно равен ДО. Отдельный прогон того же batch на промежуточном коммите дал A2 = 56 с — при двух других прогонах с отладочным логом ключа (попадание подтверждено, A2 = 5.5 с) причину выброса установить не удалось.
- Механизм напрямую (скрипт поверх `createTsProjectHost`, шпион на `getSemanticDiagnostics`, check = 3797 файлов): gate1 холодный 79.7 с / 7594 вызова; gate2 идентичный 2 мс / 0; gate3 другая правка 34.2 с / 3797 (только overlay — baseline из кэша).
- apply на APFS-клоне: batch [A dry-run, A apply] → dry-run 54.0 с, apply 35.5 с (гейт отдан из кэша; остаток — план + post-apply проход трека t-439159), `mode=applied typecheck=clean`.

### Что осталось
- Диагностики, зависящие от порядка проверки (circularity), per-file записи собраны разными checker-прогонами — тот же класс, что внутри одного Program у TS; ложный отказ закрыт пересчётом, ложный clean требует совпадения ключа.
- Не покрыто тестом: выброс устаревших результатов и кап размера ключа (память, не корректность).
