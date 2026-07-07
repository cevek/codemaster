## Present-state доки codemaster

**В скоупе:** `ARCHITECTURE.md`, `src/README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `test/README.md`,
`docs/backlog.md`. **Вне скоупа (НЕ флагай):** `docs/about-ru.md` (ручной human-нарратив),
`docs/wishlist.md` (будущее, намеренно не present-state).

Проверяй в порядке приоритета:

1. **Кросс-рефы резолвятся.** Каждый `§N`/`§N.M` → реальная секция ARCHITECTURE; каждый путь / md-линк
   существует на диске; каждый модуль/тип/файл/символ, названный докой, есть в `src/` тем же именем
   (грепни, подтверди).
2. **Док ↔ контракт.** Имена и шейпы в доках совпадают с контрактами (`src/core/*`,
   `src/config/config.ts`, `src/ops/contracts.ts`, `src/core/plugin.ts`): MCP-tool-surface; поля
   `Result`/`Fact`/`Span`/`Confidence`/`Provenance`/`FreshnessNote`/`ToolFailure`/`HandleRebind`;
   branded-типы; `Plugin`-интерфейс + DAG; каталог ops (§5-L3, §17); config-секции.
3. **Дерево ↔ реальность.** Дерево §15 и таблица слоёв src/README ↔ `find src test -type f`; лови
   listed-but-absent и present-but-unlisted.
4. **Present-state.** Нет «previously / used to / now changed / resolved / formerly / originally».
5. **Backlog.** `docs/backlog.md` — только открытые `[ ]` (флагай инверсию: айтем уже зашипан в коде,
   но висит); тег-тройка `type·imp·cx`; «In flight»-указатели → реальный `docs/spec-*.md`.
6. **Внутренние противоречия** — две доки, или дока и контракт, утверждают противоположное.
7. **`knip.jsonc`** — зависимость в `ignoreDependencies` как «declared ahead of use», которую уже
   реально импортят (пора убрать), или наоборот.
