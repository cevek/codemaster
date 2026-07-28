---
id: t-056977
title: list_endpoints.pathInclude — переименовать в pathContains (коллизия имени с глоб-массивом остальных опов)
status: backlog
priority: medium
tags:
  - intake
  - mcp
  - schema
type: dx
complexity: S
area: platform
created: '2026-07-28T16:09:33.776Z'
---
`list_endpoints.pathInclude` — `{type:'string'}` с семантикой ПОДСТРОКИ URL. У 10+ остальных опов `pathInclude` — массив глобов по путям репо. Одно имя, два несовместимых типа и две разные семантики.

Сейчас коллизия только ОБЪЯВЛЕНА в схеме (`.describe()`: «SUBSTRING of the endpoint URL path — NOT a repo-path glob»), что закрывает молчаливость, но не саму коллизию: агент, перенёсший `"api"` с `list_endpoints` на `find_usages`, получает глоб `["api"]` и не тот результат.

Фикс: канонический ключ `pathContains`, `pathInclude` — intake-алиас на него (старые вызовы продолжают работать), тело опа читает `args.pathContains`.

Рамка: проект ДО продакшена, то есть сейчас самое дешёвое окно для ломающей смены публичного аргумента — дальше цена только растёт. Не сделано в треке L2 потому, что это правка ТЕЛА опа вне цели трека (там чинились схемы), а не потому что дорого.

Готово, когда: `pathContains` — канонический ключ, `pathInclude` принимается как алиас с раскрытием в `Result.intake`, и ни один оп не объявляет `pathInclude` не-массивом.
