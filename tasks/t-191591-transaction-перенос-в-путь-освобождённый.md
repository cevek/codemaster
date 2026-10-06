---
id: t-191591
title: "transaction: перенос в путь, освобождённый предыдущим шагом (move A→B, затем C→A), даёт ЛОЖНУЮ ошибку гейта 'Cannot find module ./a'"
status: backlog
priority: low
tags:
  - mutation
  - transaction
type: bug
complexity: M
area: transaction
evidence: repro
author: ba0cb7cf
created: '2026-10-06T13:29:22.431Z'
---
Repro (inline-VFS project, на 17d1a52): src/a.ts, src/c.ts, src/use.ts импортирует обе; transaction [move_file a→b, move_file c→a] dry-run → typecheck.clean=false, introduced: src/use.ts 'Cannot find module ./a', хотя use.ts корректно переписан на './b' и './a'. Причина (по коду, не отлажено): TxnCompose.build кладёт origin src/a.ts в plan.removed (гейт-overlay его хоронит), а overlayFiles содержит файл с current=src/a.ts — tombstone побеждает. Даже при чистом гейте apply отбил бы collidingDests в refactor-plan-apply.ts (src/a.ts существует на диске до первого git mv).

После склейки серий move_file (t-255583) чистая серия отказывает честно с индексом шага; ложная ошибка остаётся для смешанных цепочек (move, rename, move-в-освобождённое).

Исход: либо честный отказ с понятной причиной на этапе compose (TxnCompose.applyStep, как уже сделано для extract в освобождённый путь), либо поддержка через упорядочивание git mv (топологически, swap — через временный путь).
