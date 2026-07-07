# codemaster — большой разбор для людей

> Этот документ — единственный в проекте, написанный **для людей и подробно**. Все
> остальные доки (`ARCHITECTURE.md`, `src/README.md`, `CONTRIBUTING.md`, `CLAUDE.md`) и
> бэклог (`task-manager`, файлы в `tasks/`) намеренно плотные и сжатые — их читают AI-агенты,
> и там экономят токены.
> Здесь наоборот: можно открыть через год, прочитать спокойно и сразу понять, что это за
> проект, зачем он, как устроена архитектура и **почему** принято каждое ключевое решение.
>
> Где живёт «истина по факту» (что есть сейчас, без объяснений): `ARCHITECTURE.md`.
> Где живёт «почему так» и общая картина: этот файл.

## Оглавление

1. [Что это и какую боль решает](#1-что-это-и-какую-боль-решает)
2. [Северная звезда: никогда не врать](#2-северная-звезда-никогда-не-врать)
3. [Темпоральная модель: почему это не база данных](#3-темпоральная-модель-почему-это-не-база-данных)
4. [Как устроен процесс (топология)](#4-как-устроен-процесс-топология)
5. [Парсинг: один парсер на домен](#5-парсинг-один-парсер-на-домен)
6. [Слои архитектуры: plugins + ops](#6-слои-архитектуры-plugins--ops)
7. [Публичная поверхность: op · status · batch](#7-публичная-поверхность-op--status--batch)
8. [Контракт доверия, выраженный в типах](#8-контракт-доверия-выраженный-в-типах)
9. [Свежесть и консистентность данных](#9-свежесть-и-консистентность-данных)
10. [Конкурентность и жизненный цикл](#10-конкурентность-и-жизненный-цикл)
11. [Рефакторинги и кодмоды](#11-рефакторинги-и-кодмоды)
12. [Фреймворк-плагины](#12-фреймворк-плагины)
13. [Вывод для агентов и дебаг](#13-вывод-для-агентов-и-дебаг)
14. [Тесты: как мы держим себя честными](#14-тесты-как-мы-держим-себя-честными)
15. [Тулчейн и гигиена](#15-тулчейн-и-гигиена)
16. [Ключевые решения и почему](#16-ключевые-решения-и-почему)
17. [Чем отличаемся от CodeGraph](#17-чем-отличаемся-от-codegraph)
18. [Карта файлов проекта](#18-карта-файлов-проекта)
19. [Где мы сейчас и что дальше](#19-где-мы-сейчас-и-что-дальше)

---

## 1. Что это и какую боль решает

**codemaster** — stateful, постоянно живущий инструмент-инспектор кодовой базы для проектов
на TypeScript/React. Он держит «тёплым» (загруженным) TypeScript Language Service, следит
за файловой системой и отвечает на структурные, семантические и рефакторинговые запросы.
Главная особенность: **его пользователь — не человек, а AI-агент** (Claude Code, Cursor и
подобные).

Боль, которую он лечит: агент в большой кодовой базе постоянно «грепает» — ищет по тексту,
открывает файлы, бегает по импортам. Тратятся токены и время. На крупном репо разведка
сжигает миллионы токенов прежде, чем агент дойдёт до самой задачи.

codemaster даёт агенту **type-aware ответы с доказательствами** через несколько точных
вызовов. С доказательством (точное место в коде) — чтобы агент мог проверить.

## 2. Северная звезда: никогда не врать

Единственное по-настоящему незыблемое правило проекта: **никогда не врать агенту.**

Если агент получит ответ, а потом случайно (например, грепнув) обнаружит, что ответ не
сходится с реальностью, он сделает единственный рациональный вывод: «этому инструменту
нельзя верить» — и навсегда вернётся к своему проверенному способу (grep + read). **Один
раз соврал — потерял пользователя.** Поэтому **корректность дороже скорости**: ответ за
5–60 секунд — нормально, неправильный ответ — фатально.

Из этого правила вытекает всё:

- **Каждый факт несёт доказательство (proof-carrying).** К утверждению прикладывается
  точное место (`файл:строка`) и дословный кусок исходника, который это подтверждает.
- **Неопределённость всегда явная.** `unresolved` / `partial` / `dynamic` — реальные
  ответы. «Не нашли» и «не смогли определить» — два разных ответа.
- **Сообщаем, что смогли и что не смогли.** Частичный результат никогда не выдаётся за
  полный.
- **Никогда не падаем.** Любой вызов внешнего инструмента (TS LS, git, ast-grep, prettier,
  файловая система) обёрнут. Падение → честное `ToolFailure`, не падение демона, не
  выдуманный результат.

Это **вшито в типы**, а не оставлено на «надо не забыть». Конверт `Result<T>` несёт поля
для доказательства, неопределённости, провала и свежести.

## 3. Темпоральная модель: почему это не база данных

Соблазн был сделать «строго правильную» синхронизацию с блокировками. Мы сознательно от
этого отказались.

Реальный сценарий: агент меняет код, а потом — через секунды — зовёт инструмент. Между
правкой и запросом всегда есть зазор. Значит, не нужна СУБД-grade синхронизация. Достаточно
дебаунс-watcher'а и ленивого пересчёта — плюс **проверка свежести на чтении** (§9), которая
ловит всё, что watcher проспал.

## 4. Как устроен процесс (топология)

```
agent ──MCP──▶ orchestrator (daemon) ──host──▶ workspace engine ──▶ dense reply
               front door · routing ·          plugins + ops
               repo registry · lifecycle       (one workspace)
```

- **`codemaster` global bin** — точка входа (`npx codemaster` или установленный).
- **Orchestrator (демон)** — один долгоживущий front-door процесс, говорящий MCP/IPC. Не
  держит данных проекта: `repoId → engine` registry, routing, lifecycle (spawn / idle TTL
  / path-existence eviction), memory governor. Heap маленький, loop не блокируется.
- **Workspace engine** — машина для одного workspace'а: набор зарегистрированных
  **плагинов** + **ops**, которые их композят. Всё в одной памяти — op'ы хопают через
  плагины с zero serialization.
- **Host** — transport seam. Две взаимозаменяемые реализации, выбираемые `config.daemon.isolation`:
  - `in-process` (default на этом этапе) — engine внутри orchestrator'а; host-вызов =
    прямой in-memory call. Дёшево, легко дебажить. Минус: heavy synchronous call блокирует
    shared loop.
  - `process` — один child процесс на workspace + IPC round-trip. Свой heap + GC, свой
    `--max-old-space-size`, ОС забирает память при kill, crash-isolation, реальная
    cross-workspace параллельность.

Engine написан **один раз, transport-agnostic**.

## 5. Парсинг: один парсер на домен

У codemaster нет отдельного «структурного индекса», построенного впереди LanguageService —
это была бы параллельная копия того, что TS уже парсит, со своей проблемой staleness.
Каждый плагин владеет парсером для своего домена и является единственным oracle'ом для
него:

- `plugins/ts` использует TypeScript `LanguageService` — и для AST (через `SourceFile`,
  кэшируется LS после первого touch), и для типов (через checker, лениво по требованию).
- `plugins/scss` использует `postcss` + `postcss-scss` (CST, syntactic only).
- `plugins/i18n` — `JSON.parse` + структурные walks.
- `plugins/schema` — TS-aware reader над `schema.d.ts`.
- Framework-плагины (`react-query`, `tanstack-router`, …) парсера не имеют — они
  consume'ят `ts`-плагин.

Внутри `ts`-плагина один парсер обслуживает оба тира («synтактический» и «семантический»),
поэтому syntactic-vs-semantic disagreement внутри него невозможен — нет двух парсеров.

## 6. Слои архитектуры: plugins + ops

Доменный слой — **плоская федерация плагинов**, не общий граф. Каждый плагин владеет
знанием одного домена со своей внутренней структурой; ops композят плагины, чтобы отвечать
агенту. **Общего графа и общего store'а нет**. Cross-tier joins — это работа op'а
(recipe-уровня), не сохранённое ребро в общей модели.

Снизу вверх:

- **L0 — Core (`src/core/`)** — только типы, ничего не импортит внутреннего: `brands`,
  `span`, `result`, `ids`, **`plugin`** (`Plugin` интерфейс + `PluginRegistry`), `json`,
  `debug`.
- **L1 — Support (`src/support/`)** — общие утилиты без доменного знания: `git`, `prettier`,
  `text-edits`, `fs`. Используются плагинами и ops.
- **L2 — Plugins (`src/plugins/<id>/`)** — единственный доменный слой. Каждый плагин
  опаковый снаружи; данные хранит как удобно (in-memory map, typed arrays, внутренний
  граф, что угодно). Все реализуют `Plugin` интерфейс (id, deps, init, dispose, freshness)
  - свои собственные public методы. **Плагины образуют строгий DAG** через декларируемые
    `deps` — циклы запрещены и ловятся ESLint'ом + рантайм-валидацией в `PluginRegistry`.
- **L3 — Ops (`src/ops/`)** — публичная поверхность для агентов. Каждый op — это
  именованная параметризованная функция `(args) => Promise<Result<T>>`, которая композит
  один или несколько вызовов плагинов. Простые op'ы — passthrough к одному плагину
  (`find_definition` → `ts.findDefinition`). Сложные — оркестрируют несколько
  (`find_unused_scss_classes` зовёт `ts.imports`, `ts.symbolAccesses`, `scss.classes` и
  диффит).
- **L4 — Daemon (`src/daemon/`)** — оркестратор: routing, lifecycle, `ProjectHost`.
- **L5 — MCP (`src/mcp/`)** — фасад: по инструменту на op + status + batch.

**Почему плоская федерация, а не общий граф:** плагины не вязнут в общей invalidation-каскаде
(каждая инвалидация локальна); framework-плагины используют свои нативные типы вместо
JSON-bag'а под общей дискриминированной union'ой; каждый плагин выбирает оптимальную
внутреннюю структуру под свой домен (i18n — flat map; SCSS — CSS-tree; react-query — своя
mutation→query lattice).

## 7. Публичная поверхность: по инструменту на op · status · batch

Каждый schema MCP-инструмента загружается в контекст агента **каждую сессию** —
фиксированный token-tax. Мы тратим его осознанно: **один MCP-инструмент на каждый op**,
чтобы каталог возможностей постоянно был в tool-list агента. Агенты слепы к непрозрачному
диспетчеру `op({name})` и недоиспользуют его; именованный инструмент на каждый op держит
каждую возможность на виду, а типизированная per-op `inputSchema` структурно убивает
ошибки формы аргументов. Цена N схем — это и есть фича (видимость + типобезопасность):

- **`<op>({ ...args, ...flags })`** — по одному инструменту на op (`find_usages`,
  `rename_symbol`, …), имя инструмента = имя op'а. Аргументы и флаги **плоские** (без
  обёртки `name`/`args`): свои args op'а плюс флаги вывода top-level (`apply`/`summaryOnly`
  для мутирующих, `verbosity`, `format`, `debug`, `root`, `sql`/`return` для табличных).
  `inputSchema` **генерируется** из канонической zod `argsSchema` op'а (единый источник
  истины = gate диспатча), плюс флаги. Плоский вызов идёт через неизменный путь диспатча:
  фасад извлекает зарезервированные ключи флагов/маршрута, остаток валидирует argsSchema
  op'а — единственный gate.
- **`status()`** — first-contact манифест. Перечисляет активные плагины, op-каталог для
  данного репо (имена + args schema + заметки + что делает), debug-неймспейсы. Per-op
  инструменты держат схемы постоянно; `status` — это **глубокое погружение** по репо
  (per-op заметки + общие концепции + freshness).
- **`batch(requests)`** — список op-вызовов (`{name, args, …}`) в одном round-trip'е.
  Результаты приходят в порядке запроса. Свежесть каждого затронутого плагина фиксируется
  один раз на входе batch'а, так что весь batch видит консистентный view (per-plugin).

Каждый op — это first-class MCP-инструмент (`find_usages`, `rename_symbol`, … по имени).
Tool-list — статический union op-каталога, сгенерированный из `OpDefinition`; op, чей
плагин неактивен для репо, честно отвечает `unavailable`. Каталог — через `status`.

## 8. Контракт доверия, выраженный в типах

Не лозунг, а свойство типов. Конверт `Result<T>` в [`src/core/result.ts`](../src/core/result.ts):

```ts
// Discriminated union: успех vs провал, чтобы консьюмер вынужден был narrow'нуть
// прежде, чем читать data — компилятор сам ловит «забыл проверить failure».
type Result<T> = OkResult<T> | FailureResult<T>;

interface OkResult<T> {
  ok: true;
  data: T;
  handle?: HandleRebind; // proof-carrying rebind когда SymbolId протух (§6 ARCH)
  freshness?: FreshnessNote; // per-plugin fingerprints + pending изменения
  truncated?: Truncation; // {shown, total, hint} — никогда silent capping
  debug?: string[]; // opt-in трасса для дебага
}

interface FailureResult<T> {
  ok: false;
  failure: ToolFailure; // внешний инструмент упал → честный отказ, не выдумка
  data?: T; // только для частичного recovery (ToolFailure.partial = true)
  handle?: HandleRebind;
  freshness?: FreshnessNote;
  debug?: string[];
}

interface Fact<T> {
  value: T;
  proof: Span[]; // дословные ranges, агент может верифицировать
  confidence: 'certain' | 'partial' | 'unresolved' | 'dynamic';
  note?: string;
}
```

Каждый плагин обязан возвращать `Result<T>` со своего public API. Op'ы агрегируют — если
op трогает несколько плагинов, `freshness` накапливает per-plugin фингерпринты, `failure`
поднимается от первого упавшего плагина (с `partial: true`, если что-то успели). Lie =
структурно невозможен.

## 9. Свежесть и консистентность данных

Самая тонкая часть для stateful-инструмента.

Ключевое решение: **свежесть проверяется при чтении, а не доверяется watcher'у.**
Watcher'ы теряют события — особенно при массовых изменениях (`git checkout`, rebase, stash).
Если бы честность висела на watcher'е, переключение ветки оставило бы заполненное дерево
при пустой очереди событий — и мы бы тихо отдавали устаревшие данные.

На каждом запросе берётся **репо-глобальный отпечаток изменений**: `git rev-parse HEAD` +
`git status --porcelain` (за один git вызов), плюс mtime walk для не-git репо. Сверяется с
тем, что записали затронутые плагины. Если разошлось — затронутые плагины переиндексят
changed-set (берётся из `git diff --name-only`) либо ответ возвращается с `FreshnessNote`.

Проверка **репо-глобальная**, а не «по файлам, что попали в ответ». Иначе find-all op
(`find_usages`, `list`) пропустил бы файл, который _должен_ был быть в ответе, но не попал
(добавленный, проспанный watcher'ом).

Роли инвертированы: **read-time проверка — это гарантия корректности, watcher — лишь
оптимизация** (фоновый pre-warm, чтобы read-time проверка обычно была no-op).

## 10. Конкурентность и жизненный цикл

**Конкурентность.** Внутри workspace engine single-threaded и сериализует свои запросы (TS
LS синхронный и нереентрабельный). Cross-workspace параллельность даётся orchestrator'ом —
он только routing, не блокируется. В `process` mode разные workspace'ы буквально в разных
процессах.

Каждый плагин гарантирует **tear-free reads**: reader пинит ссылку на состояние плагина на
входе запроса и не перечитывает её через `await`. Writer (reindex, мутирующий op) делает
синхронный build-and-swap указателя `current` — атомарно в single-threaded Node. Внутренняя
структура — на выбор плагина (copy-on-write per file shard для `ts`, простая mutation для
маленьких плагинов — что угодно).

**Жизненный цикл:**

- **Lazy spin-up** — engine создаётся на первый запрос для этого репо; каждый плагин
  тёплится на первом обращении (LS у `ts` плагина — на первой семантической op'е).
- **Idle-TTL eviction** — после N минут без запросов orchestrator dispose'ит engine; в
  `process` mode ОС полностью забирает память.
- **Path-existence sweeper** — отдельный триггер eviction'а, ключевой для worktree-spam
  сценария: orchestrator периодически `stat()`'ит `repoRoot` каждого engine'а; если папка
  исчезла (worktree удалён), engine dispose'ится **немедленно**, не ждёт idle TTL.
  Иначе orphan engine'ы копят гигабайты LS-памяти в RAM.
- **Memory governor** — orchestrator знает RSS каждого workspace процесса, эвиктит LRU при
  пересечении машинного бюджета.

**Disk-state нет.** Все плагины в памяти. Холодный старт на каждый engine spawn —
сознательное упрощение под worktree-spam workflow агентов (агенты постоянно создают
одноразовые worktree'и; персистентный кэш стал бы write-only garbage'ем). Опциональный
disk persist обсуждается в `docs/wishlist.md`.

**Cross-engine state share не делается** — каждый плагин решает свою сериализацию
по-своему, общего механизма не существует. Цена — один cold start на engine. Принято.

## 11. Рефакторинги и кодмоды

Мутирующие op'ы (`rename_symbol`, `move_file`, `extract_symbol`, `change_signature`,
`codemod`) принимают флаг `apply` (default `false`): dry-run возвращает превью (diff +
затронутые места + результат typecheck), apply коммитит. Git-aware: отказывается на грязном
дереве, делает pre/post-typecheck, атомарен, умеет auto-rollback. JSON args строго
zod-валидируются с fail-fast `did you mean…?` ошибками — чтобы агент мог писать вслепую,
без чтения доков.

Два **разных** семейства правок (путать их — значит врать кодом):

- **Symbol-anchored** (`rename_symbol`, `move_file`, `extract_symbol`, `change_signature`):
  `ts`-плагин резолвит символ через LS, op переписывает только семантические references.
  Никогда не по текстовому совпадению.
- **Shape-based** (`codemod`): структурный паттерн через ast-grep (`<X prop={$V}>`).
  Работает по форме AST и **никогда не утверждает, что метит в конкретный символ** —
  поэтому не может случайно переписать одноимённую несвязанную сущность.

Структурные рефакторинги портируются из `front-renamer` (отдельный инструмент автора,
который это уже решил — VFS + делегирование встроенным рефакторам TS).

## 12. Фреймворк-плагины

Ядро — generic, ничего не знает про конкретные фреймворки. Знание про стек живёт в
**plugin'ах**. Они — равноправные граждане, не «надстройка над общим графом», как раньше.

- `plugins/react` — детект компонентов, хуков, dialog/sheet conventions.
- `plugins/react-query` — mutations, queries, queryKeys, `invalidates` relations.
- `plugins/tanstack-router` — routes.
- `plugins/zustand` — stores.
- Любой может написать свой — declare `id`, `deps: ['ts']`, реализовать публичные методы.

Каждый framework-плагин **зависит от `ts`-плагина** (через DAG), потому что использует его
для парсинга и cross-tier observations («какой файл импортирует react-query», «где
используется queryKey X»). Cross-tier ребра не сохраняются в общем сторе — они **наблюдаются
`ts`-плагином через его API при запросе**.

## 13. Вывод для агентов и дебаг

**Вывод** — для агентов, не людей: плотный, кодированный (короткие коды + однострочная
легенда), всегда с кликабельным `файл:строка`, с явным обрезанием больших выборок («ещё N,
уточни фильтром»). Управление плотностью через `verbosity` flag; `format: 'json'` для
машинной композиции. «Размер под ответ, а не под число файлов»: когда несколько результатов
взаимозаменяемы, один показываем целиком, остальные схлопываем до сигнатур. Гайд по
использованию доставляется через MCP `initialize` (не в `CLAUDE.md`/`AGENTS.md`).

**Дебаг** — для агентов, которые _разрабатывают_ codemaster: богатый, но компактный.
Неймспейсы по подсистемам (`plugin:ts:*`, `op:find_usages`, `watcher`, `daemon`,
`eviction`, …), корр-id `req#N` через `AsyncLocalStorage` (грепнул `req#42` — получил весь
трейс одного вызова), одна машинно-греппабельная строка на событие, ротируемый лог с
капом по размеру. Никогда не пишем в stdout (там — payload для агента; засорить = сломать
MCP). Дёшево, когда выключено (no-op после single set-membership check).

## 14. Тесты: как мы держим себя честными

Принцип №1: **каждому тесту нужен независимый oracle** — фикстура это только вход.

- Oracle для `expand_type` / `assignability` — свежий cold `ts.Program`.
- Oracle для `find_usages` — LS сам, в режиме cold-rebuild vs warm-daemon.
- Oracle для мутирующих ops — git (byte-exact rollback) + `tsc --noEmit`.
- Oracle для не-TS плагинов — cold reparse.
- Text grep — **не op codemaster'а**; агенты идут в ripgrep напрямую.

Инварианты, которые гейтят CI (per plugin):

1. **Proof-span validity** — `Span.text` равен живому исходнику в его range'е.
2. **Per-plugin freshness honesty** — после mutate / add / `git checkout` ответ либо
   reindexed-correct, либо несёт `FreshnessNote`. Никогда не silent-stale.
3. **Per-plugin `cold == warm`** — для любого state'а warm-daemon answers равны
   cold-booted-daemon answers.
4. **Edit safety** — dry-run leaves git clean; `diff(dry) == diff(apply)`; post-apply
   `tsc` clean; rollback byte-exact.
5. **Op golden against oracle** — паирно с oracle, не сам по себе.
6. **Format golden** — стабильность вывода (никогда не одна; всегда + oracle).
7. **Plugin DAG honesty** — registry refuses cycles.

Большинство тестов **без папок**: проект монтируется из map в памяти через
`project({...})` (гермётично, без `npm install`; типы фреймворков — `.d.ts` заглушками).
Папки-репо — под реалистичные и e2e.

## 15. Тулчейн и гигиена

- Node ≥ 20, ESM, strict TS через raw compiler API (no ts-morph).
- ESLint (300-line cap · no-any · no-console · exhaustive switch), Prettier, knip,
  lint-staged + husky.
- Один command — `npm run fix-and-check` (eslint → prettier → tsc → knip). Должен быть
  green перед merge'ом.
- Doc'и описывают present state, никогда past («previously / used to / now changed» —
  запрещено; изменили решение — переписали как будто всегда так было).

## 16. Ключевые решения и почему

Серия архитектурных развилок, решённых под workflow агентов:

- **Один TS-парсер, не два.** Альтернатива — параллельный «структурный индекс» через
  `ts.createSourceFile` ради скорости search'а. Отказ: дубликат с risk of drift; LS свои
  AST уже кэширует.
- **Плоская федерация плагинов, не общий граф.** Альтернатива — единая discriminated-union
  graph модель с adapter-contributed entries в общем сторе. Отказ: open-bag (`adapterKind:
string` + `JsonValue`) — архитектурный долг; cross-plugin invalidation cascade —
  тяжёлая; каждый плагин лучше выбирает свою оптимальную структуру.
- **Disk-state нет.** Альтернатива — sharded snapshot per source file для warm-start.
  Отказ: агенты создают десятки одноразовых worktree'ев → кэш = write-only garbage,
  inode-bloat. Cold start приемлем.
- **Нет cross-engine state share.** Альтернатива — orchestrator-level baseline между
  worktree'ями. Отказ: под opaque-plugin-internals моделью нет общего механизма
  сериализации.
- **§3.1 переформулирован на intent-уровень.** Не «никогда не кэшируй semantic», а
  «cached semantic facts must be rigorously synchronized with current VFS state». Плагин
  МОЖЕТ внутри себя ленивым memo держать refs, если умеет sound invalidation. Не Phase 0.
- **Нет mid-call cancellation от file-change.** Ответ против запиненной версии — это
  честный snapshot, а не ложь. Если файл изменился во время вычисления, ответ всё равно
  валиден против пиннованной версии + `FreshnessNote`. Cooperative cancellation (агент или
  deadline) — отдельная wishlist-тема, не file-change.

## 17. Чем отличаемся от CodeGraph

**CodeGraph** (отдельный open-source инструмент) — code knowledge graph через tree-sitter.
Чисто синтаксический, ничего не знает про типы.

codemaster:

- **Type-aware** — настоящий TS LanguageService через `ts`-плагин. Может отвечать на
  type-зависимые вопросы (assignability, refs с правильным разрешением имён, expand type),
  делать безопасные рефакторинги, не путать одноимённые сущности в разных скоупах.
- **Не один общий граф, а федерация плагинов** — фреймворк-знание (routes, mutations,
  queryKeys, invalidates) живёт в типизированных нативных модулях, не в open-bag attrs.
- **Edit / refactor / codemod** — first-class, не вне scope'а инструмента.
- **Tradeoff** — codemaster только для TS/JS-стека (плюс SCSS/i18n/schema через
  специализированные плагины); CodeGraph language-agnostic.

## 18. Карта файлов проекта

```
codemaster/
  ARCHITECTURE.md            — source of truth, плотно, для агентов
  README.md                  — короткая визитка
  CLAUDE.md  CONTRIBUTING.md — правила работы
  tasks/                     — бэклог открытых пунктов (task-manager: MCP + `tm`), теги → поля type·imp·cx·area
  docs/
    about-ru.md              — этот файл (long-form RU)
    backlog.md               — указатель-заглушка → бэклог в task-manager (контент переехал в tasks/)
    wishlist.md              — отложенные идеи
  examples/codemaster.config.example.ts
  src/
    bin.ts                   — CLI / composition root
    core/                    — типы (Plugin, Result, ids, span, brands, …)
    config/                  — CodemasterConfig + defineConfig
    support/                 — утилиты (git, prettier, text-edits, fs)
    plugins/<id>/            — доменные плагины
    ops/                     — публичные op'ы, композят плагины
    mcp/                     — MCP фасад (per-op инструменты + status + batch)
    daemon/                  — orchestrator, lifecycle, host
    format/                  — dense rendering Result<T>
  test/
    fixtures/_typings/       — .d.ts заглушки (no npm install)
    differential/            — oracle-backed инварианты
    golden/                  — output snapshots
```

## 19. Где мы сейчас и что дальше

Сейчас — **Phase −1 (scaffold)**: ARCHITECTURE.md, src/README.md, core контракты
(`Plugin`, `Result`, ids, span, brands, debug), config, daemon host seam, MCP scaffolding
обновлены под plugin/op модель. Toolchain (eslint + prettier + tsc + knip) — green.

Roadmap (§17 ARCH) plugin-incremental:

- **Phase 0** — daemon + plugin registry + DAG validation + support utilities + freshness
  backstop + MCP фасад с пустым op-каталогом + honesty harness skeleton. Exit: `status`
  round-trips через MCP.
- **Phase 1** — `ts`-плагин (VFS + LS + module-resolve + handles) и readonly ops
  (`find_definition`, `find_usages`, `expand_type`, `assignability`, `search_symbol`).
- **Phase 2** — мутирующие ops над `ts`-плагином (rename / move / extract / codemod).
- **Phase 3** — не-TS плагины (`scss`, `i18n`, `schema`) + cross-tier ops.
- **Phase 4** — framework плагины (`react`, `react-query`, `tanstack-router`, `zustand`) +
  `list` ops.
- **Phase 5** — compound ops (composite recipes — `component_card`, `impact`, `affected`).
- **Phase 6** — `trace` ops (control + data flow через плагины).

Detail per box — в бэклоге `task-manager` (`tm list` / файлы в `tasks/`). Идеи на потом (отложенные deferral'ы,
включая cooperative cancellation, opt-in disk persistence, off-heap plugin storage) — в
[`docs/wishlist.md`](wishlist.md).
