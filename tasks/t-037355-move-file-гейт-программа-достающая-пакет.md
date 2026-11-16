---
id: t-037355
title: 'move_file гейт: программа, достающая пакет транзитивно (node_modules/workspace-ссылка), получает переписанный импортёр без нового dest → ложный Cannot find module'
status: done
priority: high
created_by_session: s-207994
type: bug
complexity: M
area: multi-program
evidence: repro
author: mi-5302e415
created: '2026-11-16T12:40:36.425Z'
---
## Симптом
`move_file` внутри workspace-пакета `packages/core` (`src/greet.ts` → `src/lib/greet.ts`, `index.ts` реэкспортирует `./greet`), который потребляет `packages/app` через `@w/core`: dry-run даёт `typecheck.clean:false` с introduced `packages/core/src/index.ts:1 Cannot find module './lib/greet'`. Ход правдивый — после move на диске всё резолвится.

Воспроизводится и на НАСТОЯЩЕЙ установке (реальный симлинк `packages/app/node_modules/@w/core`), и под эмулированными ссылками (t-403708). Если app не видит core, гейт чистый.

## Причина (прочитано: `program-gate.ts` `claimedBy` / `owns`)
Программа app владеет `index.ts` через `containsFile` (транзитивно) и получает его переписанный overlay. Новый dest не принадлежит app: `containsFile` = false (файла ещё нет), `mayContain` = false (glob app = `packages/app/src`). Поэтому overlay-проход app резолвит `./lib/greet` в пустоту.

## Минимальный исход
Программа, которая claim'ит переписанный импортёр, видит и новые пути того же edit'а, на которые этот импортёр теперь указывает. Проверка: dry-run на фикстуре `test/differential/workspace-links.test.ts` (move-тест) даёт `clean:true`, а гейт по-прежнему ловит настоящий dangle.
