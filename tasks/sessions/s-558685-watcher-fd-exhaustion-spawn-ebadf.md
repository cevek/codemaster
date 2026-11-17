---
id: s-558685
title: 'watcher: fd exhaustion → spawn EBADF'
status: closed
author: mb-6ffb47cd
assignee: mb-6ffb47cd
created: '2026-11-17T10:35:43.919Z'
started: '2026-11-17T10:35:44.277Z'
closed: '2026-11-17T10:48:45.625Z'
---

## Итог
- t-142288 закрыта. На macOS/Windows один рекурсивный `fs.watch` на корень (O(1) fd), на Linux chokidar. Фильтр событий по root-relative пути. `runGit` ловит синхронный throw spawn. Состояние degraded, полученное на старте, в status больше не перезаписывается.
- Живой прогон (in-process MCP, тёплые codemaster и claude-ui): на main после прогрева claude-ui 2034 REG fd и `spawn EBADF` на следующих вызовах; на фиксе 2 REG fd, все вызовы ок.
- Ревью: plan-reviewer — 3 BLOCK, bug-reviewer — 1 BLOCK (дубль первого). Всё закрыто в 8aea30c, петля закрыта за один круг.
- Остаток: t-074490 (синхронный throw в forkEngineChild/spawnDaemon), t-676217 (флейк usage-log-inflight под полным сьютом).
- Не проверено: путь Windows (native recursive) ни тестом, ни вживую.
