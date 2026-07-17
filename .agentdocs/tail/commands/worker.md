## Специфика codemaster

**Гейт:** `npm run fix-and-check` (EXIT 0) — авто-сносит механический dead-code (unused imports через
eslint, truly-dead exports через knip; не удаляй руками). Полный `npm test` — один раз в конце.

**Экономь прогон** (это батарея и время юзера): один раз редиректни `npm test >/tmp/t.txt 2>&1` и
грепай ФАЙЛ сколько надо; для итерации — точечно `node --test test/foo.test.ts`, не весь suite.
Сначала глянь реальный выхлоп упавшего теста, потом чини точечно, не вслепую.

**Параллельный тест-лок (несколько воркеров на одной машине).** Два одновременных полных сьюта трэшат
CPU суперлинейно (грызня за ядра). ТЯЖЁЛЫЕ прогоны — полный `npm test` и `npm run fix-and-check` —
ТОЛЬКО через machine-wide **мьютекс K=1**: `node ~/.codemaster-orch/with-test-lock.mjs -- npm test`
(и `... -- npm run fix-and-check`). Другой воркер держит лок → ты ждёшь в очереди (норма, не запускай
сьют напрямую). Таргетные `node --test test/foo.test.ts` во время итерации — БЕЗ лока. Полный сьют —
только на DONE-вехе. (Лок провижнит менеджер; если helper'а нет — пингани менеджера, не гоняй голый
сьют параллельно.)

**Oracle-backed тест (§16):** независимый оракул — cold `ts.Program` / cold reparse / отдельный
код-путь; НЕ grep и НЕ golden-only; реально падает ДО фикса.

**Соответствие проекту:** главный инвариант (never-lie / never-hang, ARCHITECTURE §1/§3), лейеринг
(downward-only, `common/`→`core/`, plugin-DAG), файл ≤300 строк, внешние вызовы обёрнуты →
`ToolFailure`, boundary zod-валидирован. Source-of-truth: CLAUDE.md · ARCHITECTURE.md · CONTRIBUTING.md
· src/README.md.

**Ревьюверы под тип правки** (поднимаешь как субагентов): `bug-reviewer` — всегда; `architecture-reviewer`
— новый seam / кросс-модуль / структура; `copy-paste-reviewer` — заметный новый код; `doc-sync-reviewer`
— правка меняет публичный контракт / output-surface / доки.

**Risk-остриё codemaster для брифа ревьюверу:** stale/freshness (§3.5), proof-span off-by-one
(1-based Loc ↔ 0-based offset), мисидентификация (алиас-импорт / same-name символ), silent-truncation,
необёрнутый внешний вызов, блокировка оркестратора синхронной тяжёлой работой (§2).

**Backlog** — task-manager (MCP), не руками. **Догфуд:** символьные вопросы веди через codemaster MCP;
его баг/трение подай в его `feedback` сам.
