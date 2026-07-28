---
id: t-359677
title: 'one-of, которые одна anyOf-группа не выражает: change_signature removeParam⊻reorder, impact_type_error.edit replace⊻remove, i18n_lookup ≤1 из key/prefix/value'
status: backlog
priority: low
tags:
  - mcp
  - schema
type: dx
complexity: M
area: platform
relates:
  - t-056977
  - t-302720
  - t-378009
  - t-392172
  - t-617982
surface:
  - mcp
  - ops
audience: both
evidence: repro
created: '2026-07-28T16:10:02.868Z'
---
`OpDefinition.requiredOneOf` — ОДНА группа «хотя бы одна из веток», рендерится в `anyOf:[{required:[…]},…]`. Этого хватило на таргет-ограничение (16 опов) и на `css_cascade` (file+class ⊻ selector).

Не выражаются одной группой:

- `change_signature` — таргет И (`removeParam` ⊻ `reorder`). Два независимых ограничения = `allOf:[{anyOf:…},{anyOf:…}]`. Сейчас в схему уезжает только таргетная группа, поэтому `change_signature {name:"f"}` без `removeParam`/`reorder` проходит границу и падает на zod.
- `impact_type_error.edit` — `replace` ⊻ `remove` ВНУТРИ вложенного объекта: `requiredOneOf` — только про верхний уровень args.
- `i18n_lookup` — «не более одного» из `key`/`prefix`/`value`: это НЕ «хотя бы одно», а `maxProperties`-подобное ограничение, другой конструкт.

Лжи нет — всё ловится zod'ом с внятным сообщением; цена — раунд-трип, и для `change_signature` (мутирующий) он платится в самом дорогом месте.

Развилка: расширять `requiredOneOf` до списка ГРУПП (`allOf` из нескольких `anyOf`) + разрешить вложенный путь, либо оставить как есть и признать частичное покрытие. Первое — рост схемы и рост поверхности ручного объявления; второе надо зафиксировать явно, а не молча.

Готово, когда: решение принято и, если расширяем, каждая ветка пиновится тем же двусторонним тестом (`test/e2e/tools-list-schema.test.ts`): ветку zod ПРИНИМАЕТ, а несоответствие ни одной — отвергает.

Четвёртый случай того же класса: **`source`** — его таргетный one-of применяется к КАЖДОМУ элементу `targets[]` (`src/ops/source.ts:19-21`), то есть тот же вложенный уровень, что и `impact_type_error.edit`. `source {targets:[{}]}` проходит границу харнеса и падает на zod.
