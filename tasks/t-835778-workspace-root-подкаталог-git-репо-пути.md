---
id: t-835778
title: 'Workspace root — подкаталог git-репо: пути porcelain относительны toplevel, забор дрейфа и dirty-гейт мутаций молча не работают'
status: review
priority: medium
parent: t-116306
tags:
  - gate
  - honesty
  - mutation
type: bug
complexity: S
evidence: reported
author: 0da85b47
assignee: 8352d423
created: '2026-10-03T14:42:15.080Z'
---
`gitStatus` (`support/git/status.ts`) отдаёт пути относительно toplevel репо, а `captureWorktree` (`support/git/worktree-snapshot.ts`) читает их как пути от workspace root: при root = подкаталог репо `hashOf` всегда даёт `absent` (дрейф контента не виден), а пересечение touched ∩ dirty в `preWriteCheck` (`ops/post-apply-verify.ts`) пусто — dirty-гейт не отказывает на грязном touched-файле. Тот же дефект был у удалённого `dirtyAmong` — не регрессия t-439159, найдено его ревью. Не воспроизведено прогоном (`UNVERIFIED`): вывод по чтению кода.

Решённый минимум: `git status` с `--relative`-эквивалентом (или префикс `git rev-parse --show-prefix` при разборе) в `gitStatus`; проверить остальных потребителей `gitStatus` (daemon/freshness.ts).


Воспроизведено и исправлено в треке t-500739 (разбор и результат — там).
