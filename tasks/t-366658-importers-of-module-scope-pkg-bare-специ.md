---
id: t-366658
title: "importers_of {module:'@scope/pkg'}: bare-спецификатор своего workspace-пакета резолвится от корня репо → resolved:false (литеральный матч)"
status: backlog
priority: medium
created_by_session: s-207994
type: bug
complexity: S
area: multi-program
evidence: repro
author: mi-5302e415
created: '2026-11-16T12:43:04.001Z'
---
## Симптом
`importers_of {module:'@scope/pkg'}` (bare-спецификатор workspace-пакета) в pnpm-монорепо даёт `resolved:false` («module unresolved … LITERAL-string matches»). Так и на настоящей установке, и под эмулированными ссылками (t-403708): pnpm не линкует пакет в корневой `node_modules`, если корень не объявляет зависимость.

## Причина
`resolveModuleArg` (`src/plugins/ts/resolve-module.ts`) резолвит аргумент так, будто его импортирует файл в корне репо (`__codemaster_probe__.ts`). Для bare-спецификатора своего workspace-пакета корень — не потребитель.

## Минимальный исход
Bare-аргумент, который называет workspace-члена, резолвится к точке входа этого пакета (из каталога любого объявившего его потребителя или из самого члена). Тогда матч идёт по identity, а не по строке. Проверка: тест `importers_of` в `test/differential/workspace-links.test.ts` даёт `resolved` ≠ false.
