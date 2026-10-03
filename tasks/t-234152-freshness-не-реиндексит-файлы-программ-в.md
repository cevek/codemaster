---
id: t-234152
title: Freshness не реиндексит файлы программ вне workspace root
status: backlog
priority: low
parent: t-116306
tags:
  - freshness
  - git
type: bug
complexity: M
evidence: reported
author: 8352d423
created: '2026-10-03T16:13:51.788Z'
---
`createFreshnessGuard` (`daemon/freshness.ts`) передаёт в `reindex` только пути под workspace root (`gitStatus.dirtyPaths`); правка файла программы вне root (tsconfig `include: ["../shared"]`, в т.ч. при root = подкаталог git-репо) двигает fingerprint, но плагинам не сообщается — ts-хост ключует такие файлы абсолютным путём (`relOf` в `ls-host.ts`), а `RepoRelPath` по контракту `mintRepoRelPath` не выходит за root. `gitStatus.outsideRoot` уже отдаёт эти пути (`../…`). Решить, как они доходят до ts reindex, не ломая контракт RepoRelPath у остальных плагинов. Не воспроизведено прогоном.
