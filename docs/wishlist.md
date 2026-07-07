# Wishlist — идеи на потом

Живой список идей. Сюда кидаем сырое; что созреет — переезжает в `ARCHITECTURE.md` +
бэклог (`task-manager` — `tm`/MCP, файлы в `tasks/`; там — закоммиченный скоуп). Здесь
только то, чего **ещё нет в бэклоге**.

## Из первого брейншторма (что не покрыто планом/рецептами)

- **`context(task)`** — сфокусированный контекст под свободно-заданную задачу: мапа
  релевантных символов + связей одним вызовом. Шире `feature_map` (тот — по имени фичи).
- **extract-container с авто-предложением** — не просто извлечь, а _обнаружить_ повторяющийся
  wiring (одинаковые наборы хуков + JSX на нескольких call-сайтах) и предложить абстракцию.
- **invalidation → downstream refetch** (2-й порядок `trace`) — от инвалидируемых query-ключей
  к конкретным хукам/компонентам, которые перефетчатся.
- **scss: diff двух классов по computed-свойствам** — не только orphan-классы, а сравнение
  вычисленных CSS-свойств (для слияния/упрощения дублей). _Требует реального `sass`/dart-sass
  — postcss-scss значения не вычисляет (ARCHITECTURE §19)._

## Новые идеи

<!-- добавляй сюда -->

- **Поиск/индекс дизайн-токенов в CSS** (цвета, размеры, spacing, шрифты, радиусы, тени…).
  _Подумать как реализовать удобно._ Боль: агенту, работающему с дизайн-системой, нужно
  находить определения токенов и их использования без грепа по hex-кодам и именам переменных.
  Сырые направления (не скоуп):
  - **Источники токенов**: CSS custom properties (`--color-primary: #...`), SCSS-переменные
    (`$spacing-md`), `@theme`/map-структуры, возможно theme-JSON. Категоризация по типу
    значения (color / length / shadow / font / radius).
  - **Оси поиска**: по имени (`--color-primary` → def + все usages); по ЗНАЧЕНИЮ («где
    используется `#fff`», «найди дубли/near-duplicate цвета для слияния» — Δ в цветовом
    пространстве, не строковое равенство); по категории («все color-токены», «все размеры»);
    обратно — «какие компоненты/классы используют токен X».
  - **Proof-carrying** как везде: `file:line` определения + verbatim значение + список usages.
  - **Где жить**: расширение `scss`-плагина или отдельный маленький `tokens`-плагин
    (`deps: ['scss']` или свой парс). Кандидат на узкий индекс `token → {def, usages[]}`
    (ср. JSX-shape index ниже) если LS/CST-walk на запрос окажется дорог.
  - **Честность/ограничение**: postcss-scss — синтаксический CST, значения НЕ вычисляет
    (ARCHITECTURE §19). Токен, заданный через вычисление (`$x: $base * 2`,
    `var(--a, var(--b))`, `color.adjust(...)`) — `partial`/`dynamic`, точное значение требует
    реального `sass`/dart-sass (та же граница, что у `scss_class_diff` по computed-свойствам).
    Литеральные токены — `certain`; производные — честно флагать.
  - **Связь с существующим**: переиспользует `scss`-плагинный обход + `cssModuleUsages`
    (TS-сторона уже видит `s.foo`); по значению-поиску — новый value-index поверх CST.

## Архитектурные deferral'ы

Зафиксированы в обсуждениях, не вошли в Phase 0+ намеренно. Каждый — кандидат, когда
проявится реальный сигнал боли; не делать спекулятивно.

- **Plugin-internal semantic memo (refs/types cache с sound invalidation).** §3.1
  reformulated: «cached semantic facts must be rigorously synchronized with current VFS
  state» — это разрешает кэш, не требует его. Плагин может внутри себя ленивым memo
  держать find_usages-результаты с per-file invalidation cascade. Цена — engineering на
  месяцы (invalidation cascade — classically hard). Триггер: если профайлинг покажет, что
  `find_usages` доминирует и каждый раз дёргает LS на одно и то же.

- **Cross-engine plugin state share.** Под старой shared-graph моделью обсуждался
  Variant α (orchestrator держит ghost-state'ы после `engine.dispose()` для baseline-share
  между worktree'ями). Под текущей plugin-internals-opaque моделью **нереально** —
  каждый плагин решает свою сериализацию по-своему, общий механизм не получается.
  Возврат к этому возможен только если плагины согласятся реализовать общий
  serialize/deserialize hook.

- **Opt-in disk persistence per plugin.** Сейчас все плагины in-memory only. Для
  long-running primary repo сценария (developer's daily workspace, не агентский worktree)
  имеет смысл `cache.persist: 'memory' | 'disk'` config flag. **Один файл per repo**
  (keyed by canonical `repoRoot`), не миллион шардов — это качественно другой профиль от
  изначально отвергнутой per-worktree per-file шарды. Включается только если pinned
  benefit (cold-start 30-60s saved per restart) перевешивает дисковый overhead.

- **CI-friendly portable cache.** Если/когда persistence сделана: in-tree mode
  (`<project>/.codemaster/`) с path-independent encoding для warm-start на холодных CI
  runner'ах через `actions/cache`-style артефакты.

- **Off-heap plugin storage (typed-array → WASM/Rust).** Каждый плагин решает свою
  внутреннюю репрезентацию. Heavy plugin (`ts`) — кандидат на typed-array-backed
  structure-of-arrays (~2-3× компактнее, фрагментирует GC значительно меньше) и далее
  WASM/Rust backing (memory compactness + GC relief). Bulk APIs (`getMany`,
  `iterByKind`) дизайнить с самого начала, чтобы JS↔WASM boundary cost не съел win.
  LS остаётся в V8 как есть (TS LS своё знает).

- **Cooperative op cancellation.** Не от file-change (это отвергнуто в §19), а через:
  (a) MCP `notifications/cancelled` от агента — стандарт MCP, агент решает «отмена»;
  (b) deadline-based timeout — «не больше N секунд, дальше `ToolFailure{tool:'timeout',
partial:true}` + что успели». Триггер: clock или агент, не watcher. Внутри
  использовалось бы `HostCancellationToken` к LS + cancel-points между await'ами в
  op-композициях.

## Узкие индексы (если профайлинг попросит)

Маленькие специализированные индексы, которые могут жить **внутри** конкретного плагина
(или в отдельном маленьком плагине), если LS-based fallback окажется слишком медленным:

- **JSX-shape index** — `tag → list of sites with literal props`. Для «найти все
  `<Button variant="primary">`» — без index'а это walk LS-кэшированных SourceFile'ов,
  что O(file count) на запрос. С индексом — O(matches). Phase 1 fallback идёт через
  walk; индекс — wishlist.

- **Cross-package symbol-name index в монорепо** — `name → SymbolRef[]` по всем
  Program'ам монорепо. Без него `search_symbol` в монорепо требует warming каждого
  package's Program (один LS instance per `tsconfig`). С ним — один lookup. Phase 1 для
  Phase 0 принимает «cross-package symbol search прогревает все packages» как редкую
  операцию.

## Condense: match known shapes by required-key subset, not exact key set

`format/render/condense.ts` `collapseKnownShape` recognises SymbolView / UsageView /
GroupRow by the EXACT sorted key list. Each new optional field (e.g. `decl` on
SymbolView in §3.1) forces adding every new key-combination, or terse output silently
falls into the verbose block-render branch. Match on a required-key SUBSET (+ guard the
discriminating keys) so adding an optional field can't quietly break condensation. Noted
from the read-side polish review; not a correctness issue (verbose fallback is honest),
so deferred.
