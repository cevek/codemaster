---
id: t-074490
title: "forkEngineChild и spawnDaemon: синхронный throw spawn (EBADF и другие errno вне списка async) уходит мимо child.on('error')"
status: todo
priority: medium
tags:
  - daemon
created_by_session: s-558685
type: bug
complexity: S
area: platform
evidence: repro
author: mb-6ffb47cd
created: '2026-11-17T10:35:57.300Z'
---
`child_process.spawn`/`fork` в Node бросают СИНХРОННО на errno вне async-списка (EACCES, EAGAIN, EMFILE, ENFILE, ENOENT). Например, на macOS при ~10240 открытых fd бросается `spawn EBADF` (repro: открыть 10300 файлов через `openSync`, затем `execFile('git',['--version'])` → sync throw `EBADF`; подробности в t-142288).

- `spawnDaemon` (`src/daemon/spawn-daemon.ts`): комментарий обещает, что провалившийся spawn деградирует через `child.on('error')`. Синхронный throw до навешивания обработчика уходит в вызывающего — bridge падает, а не уходит в in-process fallback.
- `forkEngineChild` (`src/daemon/fork-engine.ts`): throw из `fork` отклоняет `createProcessHost`, и handle «мёртвого ребёнка» не появляется.

Исход: try вокруг `spawn`/`fork`, синхронный отказ сводится к тому же пути, что async `'error'` (для fork — handle, который сразу отдаёт `onExit(null,'ERROR')`).
