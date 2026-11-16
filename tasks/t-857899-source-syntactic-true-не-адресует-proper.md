---
id: t-857899
title: 'source {syntactic:true} не адресует property assignment объектного литерала (k: v / k: () => …)'
status: backlog
priority: medium
created_by_session: s-207994
type: bug
area: ts-core
author: mi-b16a8997
created: '2026-11-16T12:31:10.074Z'
---
Индекс syntactic-пути — TS `getNamedDeclarations` (`namedDeclarations` в `src/plugins/ts/syntactic-internal.ts`, потребитель `createDeclIndex`/`indexFile` в `src/plugins/ts/syntactic-decl-index.ts`) — не содержит PropertyAssignment/ShorthandPropertyAssignment: `const api = { load: async () => 1 }` → `source {name:'load', file, syntactic:true}` промахивается, хотя `load() {}` (method-синтаксис) находится. Это частая форма «метода объектного литерала». Промах checker-пути (`nameInFileMissMessage`, `src/plugins/ts/name-in-file-miss.ts`, t-406178) добирает их отдельным обходом и называет, но его call-level редирект на `syntactic:true` для такой цели ведёт в промах. Ожидание: syntactic-индекс включает property assignment с identifier-именем (scope-политика `collapseByScope` — ObjectLiteralExpression уже scope container).
