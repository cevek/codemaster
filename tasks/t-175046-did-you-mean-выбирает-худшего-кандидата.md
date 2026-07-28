---
id: t-175046
title: "did-you-mean выбирает худшего кандидата: path → 'pathExclude' в search_symbol (в find_unused_exports тот же path → 'pathInclude')"
status: backlog
priority: medium
tags:
  - intake
  - mcp
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T15:42:05.781Z'
---
Из разбора `~/.codemaster/usage/fail.jsonl`. Ключ `path` прислан дважды, подсказка разная и в одном случае прямо вредная:

- ts=1784671801164 — `search_symbol {"query":"Select","path":"apps/emr/src/components"}` → «unrecognized 'path' — **did you mean 'pathExclude'?**»
- ts=1785159600537 — `find_unused_exports {"path":"src/features/team/TeamMemberDetailPanel"}` → «unrecognized 'path' — did you mean 'pathInclude'?»

Оба кандидата на равном расстоянии по Левенштейну от `path`, и выбор решает порядок ключей в схеме — то есть он произволен. Но семантически они ПРОТИВОПОЛОЖНЫ: агент, ограничивающий поиск папкой, по подсказке напишет `pathExclude` и получит результат, в котором нужной папки как раз и нет — молча, без ошибки. Правдоподобная пустота хуже отказа.

Два фикса, независимых:

1. При равенстве расстояния предпочитать `pathInclude` (сужение — намерение по умолчанию), либо перечислять ОБА кандидата с пояснением семантики вместо одного.
2. Лучше: завести `path` прямым алиасом на `pathInclude` в §7-нормализаторе — два попадания в 42 записях говорят, что это устойчивое написание. Тогда did-you-mean по нему вообще не понадобится.

Смежная мелочь того же класса (сообщение советует то, что уже передано): ts=1784927718175 — `find_usages {"name":"employees","file":"src/api/query-keys.ts","line":26}` → «no declaration named 'employees' on src/api/query-keys.ts:26 — pass file:line:col (the column) **or a 'name'**». `name` уже передан; полезный совет здесь только про колонку.

Готово, когда: `path` не приводит к подсказке противоположной семантики, и текст про «or a 'name'» не показывается, когда `name` в аргументах есть.
