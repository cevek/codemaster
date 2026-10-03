---
id: t-786607
title: typecheck-гейт мутаций пересчитывает baseline-диагностику всей программы на каждом вызове — кэшировать по дисковой версии программы
status: in-progress
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
