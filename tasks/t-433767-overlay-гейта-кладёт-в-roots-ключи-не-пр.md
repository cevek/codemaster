---
id: t-433767
title: Overlay гейта кладёт в roots ключи, не принадлежащие программе — overlay-программа расходится с дисковой по членству
status: backlog
priority: medium
parent: t-116306
tags:
  - gate
  - honesty
  - mutation
type: bug
complexity: M
evidence: reported
author: 0da85b47
created: '2026-10-03T14:10:33.504Z'
---
`overlayCollect` → `SingleProgram.setOverlay` (`plugins/ts/program/single.ts`, `getScriptFileNames` force-add'ит каждый ключ overlay как root), а `claimedBy` (`plugins/ts/program-gate.ts`) отдаёт primary любой путь, не owned ни одной программой. Итог: dest вне всех `include` (или gitignored dest, исключённый `loadFileList`) в overlay-проходе — root primary, а на диске после записи в программе только если его импортируют. Для файла с `declare global`/non-module script это меняет типы НЕ-touched файлов: overlay видит глобалы, диск — нет.

Сегодня это компенсирует детектор членства post-apply (t-439159: claims до гейта vs `containsFile` после reindex → recheck на полный scope). Класс закрылся бы в самом overlay: не-owned ключи достижимы только через `fileExists`/`readFile`, без force-add в roots — тогда overlay-программа = дисковая по членству и детектор не нужен. Риск, который надо проверить: ложные «Cannot find module» для importer→dest, ради которых `claimedBy`-фолбэк и вводился.
