## Специфика codemaster

**Мерило required-vs-backlog — инварианты проекта** (ARCHITECTURE §1/§3): never-lie (proof-carrying,
явная неопределённость `unresolved/partial/dynamic`, no silent-truncation), never-hang (дедлайн, no
unbounded loop, no per-call repo-scale работа), строгий лейеринг (downward-only, plugin-DAG,
`common/`→`core/`), файл ≤300 строк, внешние вызовы обёрнуты → `ToolFailure`, boundary-вход
zod-валидирован.

**Механический гейт:** `npm run fix-and-check` (EXIT 0) — он же авто-сносит механический dead-code
(не правь руками). Верификацию на мердже гоняй САМ на main: `npm run check` + `npm test`. Точечно —
`node --test test/foo.test.ts` (файл, не директорию).

**Параллельный тест-лок (борьба за CPU между воркерами).** Много worktree на одной машине → два
одновременных полных `npm test` (>1 мин, все ядра) не займут 2×, а трэшат суперлинейно (грызня за
каждое ядро). Machine-wide **мьютекс K=1** сериализует тяжёлые прогоны: helper
`~/.codemaster-orch/with-test-lock.mjs` (атомарный `open('wx')` + steal мёртвого/протухшего холдера +
release на exit/сигналах), вызов `node ~/.codemaster-orch/with-test-lock.mjs -- npm test`. Ты
(менеджер) **провижнишь helper при старте если его нет** (атомарный лок-скрипт на fs), и на мердж-гейте
гоняешь полный сьют/`fix-and-check` через ТОТ ЖЕ лок — одна очередь с воркерами, менеджер и воркеры не
сталкиваются. В бриф воркеру — **каденция:** таргетные `node --test <файл>` во время итерации БЕЗ лока
(дёшево); полный `npm test` + `fix-and-check` только на DONE ЧЕРЕЗ лок. (K=1, не семафор: полный сьют
и так сатурирует все ядра, даже 2 параллельных трэшат.)

**Source-of-truth доки:** CLAUDE.md · ARCHITECTURE.md (§1 north star, §3 trust) · CONTRIBUTING.md ·
src/README.md (лейеринг). Backlog — **task-manager** (MCP): сначала его `help` + `explain_config`,
правь через MCP, не руками.

**Догфуд:** codemaster MCP жив на этом репо — символьные / типовые / usage-вопросы (и свои, и в
брифах) веди через него, не grep. Собери `feedback` воркеров ДО их архивации — окно одно.

**Естественные швы декомпозиции:** плагины (`plugins/ts|scss|i18n|schema|react|react-query|…`)
edit-disjoint по домену; `ops/` компонуют плагины поверх (сидят над DAG). Shared-seam (напр.
`ops/intake/resolve-target`) → отдельный трек, ОДИН владелец; зависимые ребейзятся на него.

**Генерируемые файлы регенерируй, не сливай руками:** golden-снапшоты — проектным механизмом
(`UPDATE_GOLDEN`), не 3-way. Env-нюансы: fish не ест inline `VAR=cmd` → `env VAR=… cmd`;
`node --test <файл>`, не директорию.

**main строго прямой → ff-only, по одному** (CLAUDE.md).

**Реальные грабли-классы этого репо:**

- Гипотеза о root-cause часто НЕВЕРНА → отдавай воркеру как «воспроизведи в песочнице», не мандат.
- Рекуррентный класс бага (density-взрыв на `verbosity:full`) = неверный opt-in дефолт → чини
  инверсией на deny-by-default + компайл-страж (`Record<Tag,mode>`: новый тег без классификации =
  tsc-error), не whack-a-mole.
- Вывод выглядит сломанным → воспроизведи CLI one-shot свежим процессом ПРЕЖДЕ чем считать регрессом
  (частый стейл-демон, а не баг кода).
