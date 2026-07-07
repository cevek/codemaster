## Контракт codemaster (что энфорсишь)

Спека — source of truth: **ARCHITECTURE.md** §1 north star, §3 trust contract, §4 parsing model,
§5 layers, §13 debug, §16 tests; **src/README.md** — карта модулей + import-таблица; **CONTRIBUTING.md**.

1. **Лейеринг (жёстко).** Импорты только вниз. `ops/` → только `plugins/`/`support/`/`common/`/`format/`/`core/`.
   `plugins/` — строгий DAG (декларированные `deps`), без циклов и upward-рёбер между плагинами.
   `common/` → только `core/` (no I/O, no timers без `Clock`-seam). `core/` → ничего внутреннего.
   `format/` → `core` (+`common/`). Сверяй каждый новый импорт с таблицей src/README.
2. **Размещение модуля.** Тип-факт не течёт из `plugins/ts`; фреймворк-концепт не течёт из своего
   плагина; op не лезет во внутренности плагина; чистая логика НЕ в `support/` (это обёртки внешних
   тулов), внешний I/O НЕ в `common/` (pure-only); имя `utils.ts`/`helpers.ts`/`misc.ts` в
   `common/`/`support/` — запрещено.
3. **Trust-контракт (§3).** Плагин — единственный оракул своего домена, не сервит stale; результат
   proof-carrying (`Span` + verbatim); неопределённость явная; freshness проверяется на чтении
   (per-plugin fingerprint), не берётся из watcher'а.
4. **One parser per domain (§4).** `plugins/ts` — единственный TS-парсер (LS); no tree-sitter,
   no ts-morph, no второй TS-парсер, который мог бы разойтись с первым. (Единственное bounded-исключение
   — LS-relocation rescue-форк как edit-producer, не оракул фактов, §4.)
5. **Boundaries.** Внешний / сериализованный вход (config, MCP-args, IPC) — zod-валидирован на краю.
6. **Доки.** Правка, меняющая решение, обновляет ARCHITECTURE.md к present-state (no «previously/now
   changed»); `§`-ссылки резолвятся.
