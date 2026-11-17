---
id: t-142288
title: chokidar-watcher держит fd на каждый файл, включая gitignored — после ~10k fd любой spawn падает с EBADF и MCP-сервер мёртв
status: done
priority: high
tags:
  - daemon
assigned_to_session: s-558685
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


## Установлено воспроизведением (node 24.22.3, macOS)
- Порог около 10240 открытых fd (macOS `OPEN_MAX`). При 10100 fd `execFile('git')` работает, при 10230 `child_process.spawn` синхронно бросает `EBADF`. От `ulimit -n` (1048576) и `kern.maxfilesperproc` (122880) порог не зависит. Одинаково для простых `openSync` и для `fs.watch` на файл.
- Синхронный throw из `execFile` внутри executor'а `runGit` (`src/support/git/run.ts`) отклоняет промис. Отказ уходит наверх и становится `codemaster internal error … please report` на каждом вызове: freshness-гард зовёт git на каждом запросе.
- `fs.watch(root, {recursive:true})` на macOS на дереве из 20000 файлов: 12 fd на весь процесс, spawn работает. FSEvents доигрывает запись, сделанную незадолго до `watch()`, поэтому на старте бывает всплеск событий.
- Опровергнуто: «достаточно фильтровать по gitignore». Только индексируемые файлы codemaster — это уже ~1.6k fd, а машинный демон на 3–4 репы снова пересекает 10240. Затраты на файл должны быть O(1), а не меньше по константе.

## План
**Скоуп.**
1. `src/support/watch/native-recursive.ts` (новый): `createNativeRecursiveWatcher(clock, watchFn = fs.watch)` — один `watchFn(root, {recursive:true})` на корень.
   - Имя из события repo-relative. Фильтр — `hasIgnoredDirSegment` + `DEFAULT_IGNORED_FILES` (`src/support/fs/ignored-paths.ts`), затем join с root, абсолютные пути отдаются в `onChanged`.
   - Debounce, как в chokidar-адаптере.
   - `filename === null` — событие отбрасывается, read-time freshness покрывает.
   - Синхронный throw `watchFn` или событие `'error'` → `onDegraded(reason)`. В случае throw возвращается no-op handle: при `undefined` конструктор `Engine` перезаписал бы `degraded` на `'off'`.
2. `src/support/watch/platform.ts` (новый): `createPlatformWatcher(clock)` — darwin/win32 → native recursive, остальные → chokidar (inotify-watch не fd, а Linux recursive `fs.watch` в Node не умеет ignore и обходит `node_modules`). Подключается в обеих точках: `src/bin.ts` (`buildOrchestrator`, long-lived) и `src/daemon/engine-child.ts`.
3. `src/support/watch/chokidar.ts`: предикат ignore переводится на repo-relative путь (`hasIgnoredDirSegment`). Сейчас split абсолютного пути глушит ВСЕ события, если корень лежит под предком с именем `build`/`dist`/`.cache`.
4. `runGit`: `execFile` в try внутри executor'а → `resolve(fail(...))`. Это превращает отказ в честный git `ToolFailure`, а не «internal error». От исчерпания fd само по себе не лечит — лечит п.1.
5. Тот же класс синхронного throw в `forkEngineChild` и `spawnDaemon` — отдельная таска, id в комментариях на обоих сайтах.
6. Доки: ARCHITECTURE §8 (watcher), §14 (deps), §15 (layout), §16 (smoke-тест watcher'а — назвать реальный), §19 (факт про `OPEN_MAX` → spawn EBADF).

**Развилки.**
- Native recursive против «chokidar + gitignore + потолок fd» (согласованного с юзером изначально): выбран native. Затраты на файл O(1), потолок на darwin нечего охранять. Юзеру сказано.
- Linux: оставлен chokidar, а не native recursive (нет ignore, обход `node_modules`, inotify и так не тратит fd).

**Проверка поведения.**
- Unit на инжектированном `watchFn` (гоняется на любой ОС, в т.ч. Linux CI): фильтр ignored, join в абсолютный путь, отброс null, degrade при sync throw и при `'error'` (состояние остаётся degraded, не off), debounce через fake clock.
- Real-fs тест только на darwin (на остальных ОС skip с причиной): ~2000 файлов, watcher от `createPlatformWatcher`, прирост `/dev/fd` ограничен; изменение файла доходит событием. Перед доверием тест должен покраснеть на `createChokidarWatcher`.
- Живой прогон: long-lived in-process сервер из worktree, тёплые codemaster и claude-ui, REG fd на pid против `main` (~10k), свой `CODEMASTER_SOCK_DIR`, kill только своих PID.

**Ревью.** bug-reviewer, 1 круг на `base..tip`. architecture-reviewer не нужен: новый адаптер за существующим `Watcher`-seam, границы блоков и контракты не меняются; `watchFn` — внутренний параметр адаптера, а не новая граница.
