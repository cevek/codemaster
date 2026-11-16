---
id: t-075901
title: "find_unused_exports: path/pathInclude 'apps/web/src' проходит 0 из 157 файлов"
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: bug
complexity: S
area: impact-usages
relates:
  - t-549028
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:56.744Z'
---
## Симптом
root = worktree claude-ui chat-design-port: `find_unused_exports {path:'apps/web/src'}` и `{pathInclude:['apps/web/src/**']}` → 'walked 0 of the 157 source file(s)' для tsconfig.json. Либо primary не содержит apps/web (тогда нота должна сказать «этот путь не в программе X, в программе Y»), либо фильтр матчит не тот вид пути.

## Минимальный исход
Различить причину: фильтр, вычистивший заселённую программу, при том что файлы пути ЕСТЬ в другой программе — называть ту программу (runnable: `programs`/`root`).

## Фрикшены
f-cvvqjkvd-15
Inbox: «find_unused_exports path filter matches nothing» (2026-11-11T11:05).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
