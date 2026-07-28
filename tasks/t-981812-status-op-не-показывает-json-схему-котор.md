---
id: t-981812
title: status {op} не показывает JSON-схему, которую видит харнес в tools/list
status: backlog
priority: low
tags:
  - mcp
  - schema
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T15:18:30.944Z'
---
`status {op:"search_symbol"}` рендерит `argsHint`-строку + notes + columns + example, но не показывает сгенерированный `inputSchema` — типы, минимумы, enum'ы (`limit maximum:500`, `minItems:1` у `pathInclude`/`pathExclude`), набор навешанных общих флагов и то, какие из них есть у ЭТОГО опа (`apply`/`summaryOnly` только у мутирующих, `sql`/`return` только у table-bearing).

Следствие: на вопрос «какой контракт уходит в `tools/list` для опа X» codemaster ответить не может — схему приходится доставать средствами харнеса. Инструмент не описывает собственную публичную поверхность.

Предложение: `status {op:"X", schema:true}` (либо секция под `full`), печатающий ровно тот JSON Schema, что уходит в `tools/list`, включая навешанные флаги. Побочная польза — анти-дрейф: видно, что advertised schema совпадает с каноническим zod-гейтом.

Смежное: [[t-029489]] (висячий `$ref` в той же схеме) — этот оп сделал бы такой дефект видимым из самого codemaster.

Готово, когда: схему любого опа можно получить через `status`, и она байт-в-байт та, что отдаётся в `tools/list`.
