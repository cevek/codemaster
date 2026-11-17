---
id: t-142288
title: chokidar-watcher держит fd на каждый файл, включая gitignored — после ~10k fd любой spawn падает с EBADF и MCP-сервер мёртв
status: todo
priority: high
tags:
  - daemon
type: bug
complexity: M
area: platform
evidence: measured
author: mb-6ffb47cd
created: '2026-11-17T10:17:43.692Z'
---
## Симптом
MCP-сервер `codemaster v0.1.0 @63dd9cf3a` (pid 81214, `mcp --in-process`, warm roots: codemaster + claude-ui). Первый `find_usages {root:"/Users/cody/Dev/claude-ui"}` ответил нормально. После этого КАЖДЫЙ вызов, даже `status {}`, отвечает `codemaster internal error: spawn EBADF (daemon still up; please report)` (catch в обработчике CallToolRequest, `src/mcp/server.ts`). Сервер жив, но бесполезен до рестарта.

## Измерено (lsof -p 81214)
- 10354 открытых fd, из них 10336 REG — по fd на каждый файл дерева.
- Больше всего под claude-ui: `scratch/` 4564 (gitignored: `scratch/antigravity-asar-extracted/`, `scratch/python-poc/`), `tasks/` 1596, `apps/` 1244 (в т.ч. 272 fd на `apps/desktop/release/Claude` — собранный app-бандл, gitignored), `packages/` 830, `.playwright-mcp/` 99 (gitignored). Под codemaster: `tasks/` 632, `src/` 489, `test/` 406.

## Механизм (частично установлен)
- `createChokidarWatcher` (`src/support/watch/chokidar.ts`): chokidar ^4 без fsevents на macOS ставит `fs.watch` на каждый файл, это fd на файл.
- Его `ignored` проверяет только имена из `DEFAULT_IGNORED_DIRS` и `DEFAULT_IGNORED_FILES` (`src/support/fs/ignored-paths.ts`), gitignore не учитывает. Поэтому смотрятся `scratch/`, `release/` и `.playwright-mcp/`, хотя их нет ни в индексе, ни в программе.
- Как именно рост fd превращается в EBADF у `child_process.spawn`, не установлено. Кандидаты: spawn-сайты на каждом вызове — `readLastSuspension` (`sysctl`, `src/support/suspension/last-suspension.ts`) и `runGit` (`src/support/git/run.ts`). `ulimit -n` в шелле равен 1048576, `launchctl maxfiles` — 256 soft. Лимит процесса сервера не снимал.

## Направление
- Watcher смотрит только то, что входит в индекс (gitignore-aware набор, тот же, что `isJunkRelPath`), или каталоги, а не файлы.
- Нужен бюджет fd с честной деградацией watcher'а: `onDegraded`, плюс read-time freshness (§3.5). Так исчерпание fd не убивает остальные пути.
- Отказ spawn на каждом вызове — это класс «never hang / every external call wrapped». Сейчас он отравляет весь сервер: проверить, что исключение уходит из обёрнутого вызова, а не из обёртки.
