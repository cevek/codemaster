---
id: t-057191
title: '§7-гейт: introduced-ошибки не подписаны программой — по ответу не понять, чья опция их дала'
status: backlog
priority: medium
tags:
  - dogfood
  - dogfood-nov
created_by_session: s-207994
type: dx
complexity: S
area: ts-refactor
audience: external
evidence: repro
author: mi-71ed3970
created: '2026-11-16T12:36:30.348Z'
---
## Симптом
`move_file` в claude-ui (t-401540) показал 17 introduced из 4 программ одним списком без метки программы: `--jsx is not set` от `tsconfig.base.json`, `Cannot find module` от `apps/web/tsconfig.scripts.json`. Различить их удалось только временным патчем `[label]` в `gateAcross`. Агент, которому гейт отказал, не видит, какая программа (какие compilerOptions) отвергла перенос, и не может решить, ложная ли это тревога.

## Минимальный исход
Каждая introduced-строка гейта несёт label программы, которая её дала (у одной ошибки из двух программ — обе). Ключ multiset-диффа baseline/overlay от этого не меняется.

Репро: копия claude-ui e4f930a2 + `pnpm install --offline`, `node src/bin.ts op move_file '{"from":"apps/web/src/components/HostName.tsx","to":"apps/web/src/components/sidebar/HostName.tsx"}' --root <копия>`.
