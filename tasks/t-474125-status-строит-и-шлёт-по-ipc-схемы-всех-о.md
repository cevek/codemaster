---
id: t-474125
title: status строит и шлёт по IPC схемы ВСЕХ опов, хотя печатает только одну (status {op})
status: backlog
priority: low
tags:
  - daemon
  - mcp
type: perf
complexity: S
area: platform
created: '2026-07-28T16:26:27.696Z'
---
`buildWorkspaceStatus` (src/daemon/workspace-status.ts) кладёт `inputSchema` в view КАЖДОГО опа, а рендер печатает её только на single-op пути (`renderOps(..., {schema:true})`). Значит терсовый `status` и `status {full:true}` тащат ~36 KB схем через IPC (process-режим) и выбрасывают их.

CPU почти не тратится — билдер мемоизирован per-op-definition (WeakMap), — но payload реальный.

Почему не починено сразу: чтобы строить схему только для запрошенного опа, имя опа нужно протащить в `engine.status()`, то есть тронуть daemon-протокол; это шире schema-трека.

Готово, когда: `status` без `op` не несёт ни одной `inputSchema`, а `status {op:"X"}` несёт ровно одну — ту же, что в `tools/list` (существующий пин в `test/e2e/tools-list-schema.test.ts` должен продолжать проходить).
