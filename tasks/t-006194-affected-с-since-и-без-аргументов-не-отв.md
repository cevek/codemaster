---
id: t-006194
title: affected (с since и без аргументов) не отвечает до таймаута MCP 300 с на worktree монорепо claude-ui
status: review
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: bug
complexity: M
area: impact-usages
audience: external
evidence: reported
author: mb-ce356acc
assignee: mi-a8edb1f7
created: '2026-11-16T09:41:53.283Z'
---
## Симптом
`affected {root:'<worktree claude-ui>', since:'55a18d816', testGlobs:['**/scripts/test-*.ts']}` → `MCP tool affected timed out after 300s`. Диф ~20 файлов, включая хаб (session.ts), импортируемый большинством ~450 сьютов. Без аргументов — тот же таймаут (2026-11-13). Нарушение §1 never-hang: `daemon.opDeadlineSeconds` = 120 с должен был вернуть `timeout`/`partial` раньше 300 с.

## Минимальный исход
Выяснить, какая часть не под дедлайном (холодный build программ worktree? обход импорт-графа?) и поставить её под `Deadline` → честный `partial` с тем, что успели. Тест на масштаб, не 3-файловая фикстура.

## Фрикшены
f-6rnmhlytt7fr, f-sfhtvz2w3u7p
Inbox: «affected times out (300s MCP watchdog) on a since-ref query against a worktree root» (2026-11-16T06:39).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.


## Разбор: замер «до» (база 2b55a94)

Метод: CLI one-shot `node src/bin.ts op … --root <дерево>` под `/usr/bin/time`, по одному прогону, вывод в файл. Деревья — клон claude-ui в /tmp + `git worktree --detach` (форма снапшота: `.git`-файл).

| дерево | вызов | wall | RSS |
|---|---|---|---|
| worktree @42c6c7a8, без node_modules | `affected {since:'42c6c7a8^', testGlobs:['**/scripts/test-*.ts']}` (36 изменённых, вкл. `apps/server/src/session.ts`) | 27 с | 1.5 ГБ |
| worktree @95b75909^ + грязные файлы 95b75909 (23 шт.), без node_modules | `affected {}` | 20 с | 1.5 ГБ |
| то же + `pnpm install --frozen-lockfile --prefer-offline` | `affected {}` | **249 с** | 1.8 ГБ |
| то же, с node_modules | `batch` 4× `find_usages` | 9 с | 1.4 ГБ |

Живой след на этом хосте (`~/.codemaster/usage/success.jsonl`): 2026-11-06 `affected {}` на worktree claude-ui `usage-vendor-refusal` — 267 748 мс, те же 23 файла. Это та же форма, она воспроизведена выше.

## Разбор: где уходит время

CPU-профиль (`--cpu-prof`) прогона за 249 с:
- 233 из 239 с — `importerClosure` → `ts.importersOf` → `findImporters` → `matches`;
- из них `resolveSpecifier` (`ts.resolveModuleName`) — 139 с, `samePath` (два `realpath` на каждую проверку) — 86 с;
- сборка программ — около 6 с.

Временная трассировка: **759 вызовов `importersOf` по ~290 мс**, итого около 220 с. Каждый вызов заново резолвит каждый импорт каждого файла каждой программы. Кэш `resolveSpecifier` живёт один вызов: он создаётся внутри `findImporters`. Без node_modules один вызов стоит ~25 мс: резолвер не находит пакетов и выходит рано. Поэтому без node_modules не висит.

Дедлайн `daemon.opDeadlineSeconds` (120 с) `affected` не видит вообще: `buildClosure` вызывается без `ctx.deadline`. Весь веер изменённого набора — один `expand(SEED)`, внутри которого опроса нет.

Опровергнутое в постановке:
- **«Снапшоты без node_modules» — неверно.** `createSnapshot` в claude-ui (`apps/server/src/worktrees/worktree.ts`, `mirrorNodeModules`) зеркалит node_modules родителя. Без них репро не висит.
- **`since` или без аргументов — не фактор.** Решает число вызовов `importersOf` (размер замыкания), умноженное на стоимость одного резолва, а она растёт с node_modules.
- **Холодный билд программ — не причина**: около 6 с.

t-877573 (batch/source на снапшоте) локально не воспроизведён: 4–9 с на той же форме. Гипотеза — побочный эффект. Две записи на mac (21:07 и 21:08 UTC 15.11, два разных снапшот-root) пришли в один общий in-process демон. Если в это окно там шёл синхронный многоминутный вызов (класса этого `affected`), он держал общий event loop. Проверка — usage-лог mac за эти окна; запрошен у агента на mac (mb-8a9d9157).

## План

Скоуп t-006194 (код). t-877573 — только расследование: кода в этом треке нет, исход по логам mac.

1. **Индекс обратных импортов на программу** — новый файл `src/plugins/ts/import-index.ts`.
   - Для одного `ts.Program` один проход: файлы вне `/node_modules/` → `moduleSpecifierOf` → `resolveSpecifier` (тот же `ts.sys`-резолв с тем же кэшем `(dir|spec)`) → `realpath` резолвнутого пути, мемоизированный по пути.
   - Результат: `byTarget: Map<canonAbs, Row[]>` плюс `bySpec: Map<rawSpec, Row[]>` для фолбэка нерезолвящейся цели (сегодняшнее `spec === moduleArg`).
   - Строка — `{at, imports}` в порядке файлы → инструкции.
2. **Инвалидация — по идентичности `ts.Program`.** Проверено: `LanguageService.getProgram()` отдаёт тот же объект без изменений и новый после правки. Это скрипт на сыром LS. Тест пиннит то же свойство на нашем хосте.
   - Хранение: `WeakMap<ts.Program, Index>` в per-instance памяти плагина (как `createScanMemos`), сброс в `dispose`.
   - Программы, подгруженные позже через `ensureProgramFor`/`programs:`, не меняют `projectVersion`. Их покрывает обход `host.programs()` на каждый вызов: индекс берётся по каждой программе.
3. **`findImporters` (режим модуля) читает индекс.**
   - `targetAbs` → `canon(targetAbs)` → `byTarget`, иначе `bySpec[moduleArg]`.
   - Дедуп по `at` поперёк программ и порядок строк — как сейчас.
   - Режим поддерева (`findImportersSubtree`) не трогаю: один вызов на операцию, не в цикле.
   - Сигнатура `TsPluginApi.importersOf` не меняется.
4. **`affected` под дедлайном.**
   - `buildClosure(..., ctx.deadline)`.
   - Опрос `ctx.deadline.expired()` между источниками в seed-веере: срабатывание → `truncated` и признак таймаута.
   - `capped.by==='timeout'` или таймаут в seed → `partial(data, {tool:'timeout'})` с `complete:false` и `!!`-нотой «LOWER BOUND, бюджет исчерпан», как в `impact`.
5. **Доки, которые правка делает ложью.**
   - Нота op `affected` и док-комментарий `importerClosure` («un-memoized O(files) scan»).
   - ARCHITECTURE §3.1: санкционированный кэш, его авторитет инвалидации и унаследованная дыра. Смена node_modules без смены Program — тот же класс, что t-710809.
   - §1/§19: список операций с опросом дедлайна на границе цикла дополняется `affected`.

Развилки:
- **Брать `program`-овы resolvedModules** (`sourceFile.resolvedModules` / `program.getResolvedModule`) вместо повторного резолва. Быстрее, но семантика под оверлеем и VFS-хостом может разойтись с сегодняшним `ts.sys`-резолвом. Доказать эквивалентность дороже. Беру минимальный путь: тот же резолвер, мемоизированный.
- **Ключ `projectVersion` + метки программ** вместо идентичности Program. Отклонено: `ensureProgramFor` не бампит версию, а ключ надо выводить руками. Идентичность Program инвалидирует по построению.
- **Ускорить только `samePath`** (кэш realpath) без индекса. Отклонено: остаётся O(узлы × импорты репо) — это нарушение §1 «per-call work that scales with repo size».

Проверка:
- **Снапшот «после»**: те же 4 команды. Вывод `affected` побайтно совпадает с `before-*.out` (diff). Время — в таску.
- **Путь дедлайна на реальном дереве**: `codemaster.config` с малым `opDeadlineSeconds` в клоне → честный `timeout`/partial.
- **Тесты**:
  - (a) страж класса: N вызовов `importersOf` на одном состоянии программы — `ts.resolveModuleName` вызывается только на первом. Красный на базе.
  - (b) свежесть: добавить импорт → reindex → новый импортёр виден.
  - (c) программа, подгруженная позже (nested config), даёт строки.
  - (d) `affected` с исчерпанным бюджетом → `partial` timeout, `complete:false`; по образцу `op-deadline.test.ts`.
- **Регрессия по путям**: `differential/affected`, `importers-subtree*`, `multi-program-usages`, `find-usages-nearest-config`, `programs-lever`, `op-deadline`, `semantic-fanout-guard`.
- **Латентный бюджет на большом репо** в сьюте есть только как e2e-смоук, не на claude-ui. Счётный страж (a) ловит именно класс «поиск на вызов растёт с репо» детерминированно. Замер на снапшоте закрывает абсолютную цифру.

Ревьюверы кода: bug-reviewer. architecture — нет: новый файл внутри `plugins/ts` за тем же `importersOf`, контракты и слои не меняются.

Потребители того же шва (`resolveSpecifier`/`samePath` на вызов):
- `phantom-imports`, `call-identity-scan` (под мемо `literalCalls`), `importers-subtree`, `unused-exports-classify`, `refactor/imports/*`;
- все — один проход на вызов операции, не в цикле. Не затронуты, в доклад.


## Поправка к плану (после OK)
Резолв в индексе — `program.getResolvedModule(sf, spec, ts.getModeForUsageLocation(sf, specNode, options))`, то есть то, что TS уже разрешил в этой Program через её хост. Голый `ts.sys.resolveModuleName` не используется: обёртка хоста (workspace-эмуляция t-403708) видна по построению, importers_of/affected согласованы с find_usages.

Песочница (`/tmp/nhd2/scripts/cmp-resolve.ts`): все импорты всех программ вне node_modules, старый `resolveSpecifier` против program-resolved, равенство через `samePath`.
- claude-ui с node_modules: 22 024 импорта, расхождений 0, полный проход 260 мс против 22 мс.
- claude-ui без node_modules: 12 530 импортов, расхождений 0.

Индекс по идентичности Program остаётся: без него каждый вызов всё равно платит по `realpath` на импорт (86 с из 233 в профиле). Резолв ЦЕЛИ (`resolveModuleArg`, один на вызов) не меняется.
Развилка «resolvedModules программы» из плана выбрана вместо «тот же ts.sys-резолв».
t-877573 остаётся открытым (in-progress), без репро не закрывается.


## Поправка к плану после ревью плана
Резолв program-own (`getResolvedModule`) отклонён. Проверено: правка `dep/package.json` `types` + `reindex` сохраняет тот же объект `ts.Program` вместе с устаревшим резолвом внутри него. Старый `importers_of` (`ts.sys` на каждый вызов) видел новую цель, program-own индекс — нет. Это регрессия в опасную сторону: в `affected` пропущенный тест.

Итог:
- Индекс резолвит прежним общим `resolveSpecifier` (шов, через который ходят все сканеры импортов). t-403708, меняя этот шов, покрывает и индекс.
- Ключ — объект `ts.Program` И `projectVersion()`: каждый reindex бампит версию.
- Остаточная дыра: изменение, о котором не сообщает ни один reindex (установка в gitignored node_modules), — индекс так же устарел, как warm LS (t-710809); записано в ARCH §3.1.

## Результат (после)
Тот же метод, что «до».

| дерево | вызов | до | после | вывод |
|---|---|---|---|---|
| worktree с node_modules, 23 грязных файла | `affected {}` | 249 с | 10.7 с | побайтно тот же |
| worktree @42c6c7a8 без node_modules | `affected` с since, 36 файлов | 27 с | 6.2 с | побайтно тот же |
| worktree с node_modules | `affected {since:'95b75909~20'}`, 500 изменённых | — | 9.2 с | — |
| то же, `opDeadlineSeconds: 1` | `affected {}` | — | 9.2 с (сам warm не отменяется) | `FAIL tool=timeout partial=true`, `complete=false`, `!!`-нота |

Стражи краснеют на сломанном коде (проверено временной поломкой):
- пересборка индекса на каждый вызов → красный страж масштаба;
- ключ без `projectVersion` → красный тест `package.json`;
- снятый опрос дедлайна в seed-веере → красный тест дедлайна.
