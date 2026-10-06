---
id: t-515246
title: engine-child всегда создаёт chokidar — эскалированный (process-mode) движок из разового CLI платит обход и закрытие watcher'а
status: backlog
priority: low
tags:
  - daemon
  - perf
type: perf
complexity: S
area: platform
evidence: reported
author: ba0cb7cf
created: '2026-10-06T13:29:23.018Z'
---
t-255583 убрал watcher из разового CLI (bin.ts buildOrchestrator: status/op/batch → nullWatcher). Но оверсайз-репо эскалирует в дочерний процесс (daemon/escalate.ts), а serveEngineChild (src/daemon/engine-child.ts) жёстко создаёт createChokidarWatcher — разовый CLI на большом репо по-прежнему платит начальный обход chokidar и его close() при shutdown (in-process профиль копии amiro: close ≈7–9 с; для child не замерено).

Исход: выбор watcher'а передаётся ребёнку при форке (fork-engine.ts), разовый CLI просит 'none'. Пересекается по файлам с t-833715 — брать после него.
