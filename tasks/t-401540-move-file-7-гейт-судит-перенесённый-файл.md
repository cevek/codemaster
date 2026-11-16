---
id: t-401540
title: 'move_file: §7-гейт судит перенесённый файл чужой программой (tsconfig.base.json / корневой) → ложные introduced-ошибки, apply отклонён'
status: backlog
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: bug
complexity: M
area: ts-refactor
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:51.479Z'
---
## Симптом
claude-ui (pnpm-монорепо):
1. `move_file apps/web/src/components/SortableProjects.tsx → …/sidebar/SortableProjects.tsx` — гейт насчитал 11 introduced ("--jsx is not set", "Cannot find name 'document'") из программ `tsconfig.json` / `tsconfig.base.json`, которые apps/web/src не включают.
2. `move_file apps/server/src/sessions/userWords.ts → sessions/api/userWords.ts` — 20 ошибок 'not under rootDir apps/server' (TS6059) по файлам packages/protocol из программы `tsconfig.base.json/apps/server`.
Ручной перенос в обоих случаях проходит `pnpm typecheck`.

## Гипотеза
Правило «program affected, если его glob владел бы файлом» (ARCHITECTURE §5-L2, writes fan out) втягивает base-конфиг, который реальный typecheck проекта не гоняет; либо base-программа baseline/overlay несимметрична по новому пути.

## Минимальный исход
Ошибки, которые гейт приписывает программе, не включающей ни исходный, ни целевой путь по своему include, не считаются introduced (или гейт не включает такую программу). Тест: двухпакетная фикстура с base-конфигом без jsx.

## Источник
Inbox: «move_file typecheck gate judges a moved .tsx by tsconfig.base.json…» (2026-11-05T17:37), «move_file refuses on spurious rootDir errors…» (2026-11-15T21:40).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
