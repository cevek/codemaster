---
id: t-406178
title: source по name+file не находит методы/геттеры класса и методы объектного литерала (could not anchor a top-level declaration)
status: done
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: dx
complexity: M
area: ts-core
relates:
  - t-271823
audience: external
evidence: reported
author: mb-ce356acc
assignee: mi-b16a8997
created: '2026-11-16T09:41:51.921Z'
---
## Симптом
Самый частый фрикшен месяца (~14 записей): `source {name:'accountId', file:'…/journal.ts'}` и т.п. для методов классов, геттеров, методов объектного литерала, вложенных функций → `could not anchor a top-level declaration`. Агенты уходят в rg или угадывают координаты. Аналогично `expand_type` по имени импортированного `Page` (f-wfjbncbpc4sg).

## Контекст
Чекер-путь якорит только top-level (ARCHITECTURE §5-L2); `source {syntactic:true}` уже адресует вложенные декларации. Обобщение name+file на члены — t-271823 (там названы find_definition/expand_type, source нет).

## Минимальный исход
Дешёвая честная половина: ошибка `could not anchor` при наличии одноимённой вложенной декларации в этом файле называет её (`Class.method @file:line:col`) и runnable-редирект (`source {syntactic:true}` с теми же args / точная позиция). Полная — в рамках t-271823.

## Фрикшены
f-ajg3iohediep, f-fd373j7hibxu, f-sq3fl6ilt6y6, f-o4uunnlsux2e, f-34x43v6etdjd, f-flu347i7quns, f-33vt34nq576d, f-renj4zemkfzi, f-u7zcsxixr223, f-5nnn7ovuxqvd, f-rb4w36i3h5vy, f-u5ww2urm75u4, f-aitousrmqeqt, f-zxzkwdk2dygf, f-wfjbncbpc4sg

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.


## Репро (2026-11-16, этот репо, CLI `node src/bin.ts op source`)
Подтверждено, тег UNVERIFIED снимаем по факту:
- checker `source {name:'status', file:'src/daemon/engine.ts'}` (метод класса), `{name:'reindex', file:'src/plugins/ts/ls-host.ts'}` (метод объектного литерала), `{name:'visit', file:'src/plugins/ts/member-in-file.ts'}` (вложенная const) → все `could not anchor a top-level declaration`.
- те же args с `syntactic:true` → `visit` печатается; `status`/`reindex` → пик-лист из 2 SymbolId (интерфейс + реализация).
- Факт о системе: checker `source` ПО ПОЗИЦИИ метода объектного литерала (`ls-host.ts:398:5`) печатает декларацию контекстного типа (`ls-host.ts:59:3`, сигнатура интерфейса), а не сам метод — go-to-definition идёт через контекстный тип. Метод класса (`engine.ts:132:3`), вложенная const (`:96:9`), smart-string `{name:'src/daemon/engine.ts:132:3'}` — печатают то, что по адресу. Импорт-спецификатор по позиции → определение в другом файле (норма checker-пути).
  → позиция — верный редирект для find_definition/expand_type, но НЕ для `source` по члену объектного литерала; для `source` верный редирект — `syntactic:true` (печатает декларацию ПО адресу).

## План
Объём — честная половина. Полная (резолв члена по name+file) — это и есть t-271823 (подъём `membersNamedInFile` в `resolveNameInFile`), не тяну.

1. `src/plugins/ts/name-in-file-miss.ts` (новый, ≤100 строк): `nameInFileMissMessage(sf, name, file)`. Кандидаты — `namedDeclarations(sf).get(name)` (тот же @internal-индекс, что у syntactic-пути, → кандидаты совпадают с тем, что найдёт редирект), дедуп по якорю имени, исходный порядок. Метка: `Container.name (kind) @file:line:col`, контейнер — ближайший именованный класс/интерфейс/type/enum/функция/переменная; член объектного литерала помечен `in object literal`, импорт/реэкспорт — `import`/`re-export`. Список через `nameWithMore` (8 + `+N more`), счёт полный (обход файла завершён). Текст нейтральный (не «nested»: сюда попадают и top-level binding pattern, namespace-импорт): «declared in this file at positions this top-level lookup does not anchor: … — address one by file:line:col; an object-literal member's position resolves through its contextual type». Пусто / helper недоступен (`namedDeclarationsAvailable()`=false) / бросил → прежнее сообщение байт-в-байт (try/catch, не исключение).
2. `src/plugins/ts/resolve-target.ts` `resolveNameInFile`: в ветке «нет top-level» вызывает (1). Выигрывают все name+file-адресуемые opы (find_definition, expand_type, impact, …), не только source.
3. `src/ops/source.ts`: checker-промахи формы name+file-без-позиции (ровно домен `resolveNameInFile`, гейт по форме цели, не по тексту) собираются, и ответ получает ОДИН call-level `redirect` = `navigationFor('source', {targets: промахнувшиеся}, 'this-call')` из `ops/guard/navigate.ts` (существующая запись `source` → `syntacticModeAlternatives`: точный вызов с `syntactic:true`, фолбэк на один таргет при длинном бэге). Не по строке на таргет (20 таргетов × RUN INSTEAD — раздув токенов). Слой ops→ops/guard разрешён (refusal.ts уже так импортит).
4. `src/format/render/render-source.ts`: опц. `redirect?: string` в данных, строкой после `unresolved`.

Развилки:
- Где кандидаты: в общем резолвере (выбрано — класс проблемы общий для всех name+file opов) vs только в source.
- Редирект source: call-level поле (выбрано) vs в каждый `reason`.
- Гейт по форме включает и «file not in TS project», и top-level неоднозначность: для обоих syntactic — законный ответ на тот же вопрос (сканирует файлы вне tsconfig; даёт пик-лист SymbolId), `gives` честно говорит, что это. Точнее без текстового матча не отличить; не стоит нового контракта `findDefinition`.
- Сканер: `namedDeclarations` (выбрано, = syntactic-индекс) vs `nonTopLevelDeclarationsNamed` (нет вложенных функций/переменных и object-literal property-assign — как раз частые фрикшены).

Проверка:
- Тест `test/differential/…` (по test/README): фикстура — метод класса, геттер, метод объектного литерала, вложенная функция, импорт-спецификатор, top-level binding pattern, отсутствующее имя. Оракул — round-trip: каждый напечатанный `file:line:col` скармливается тому же checker-резолву (`find_definition` по позиции), утверждаем, что якорь — декларация с этим именем (ловит off-by-one колонки); отсутствующее имя — прежнее сообщение без кандидатов. Плюс op-тест source: промах name+file даёт `redirect` с `syntactic:true` и тем же таргетом; таргет по позиции/symbolId — без redirect.
- Существующие `resolve-line-miss.test.ts` / `find-usages-member-fallback.test.ts` — проверю, не пиннят ли старую строку.
- Живой прогон: три репро-цели выше через CLI.
- Гейт узкий: typecheck + lint + build + затронутые тесты по путям (fix-and-check без сьюта).

Ревью кода: bug-reviewer, 1 круг. Раскладка блоков не меняется (новый файл внутри plugins/ts, поле в source-данных) — architecture не нужен.
Пересечение с t-720126: она сворачивает прозу на L5 (включая navigate `gives:`) при рендере; мой redirect — новая точка эмиссии той же прозы, файлов её плана (mcp/, format/render/fold-prose.ts, source-syntactic.ts) не трогаю; `render-source.ts` — аддитивное поле.


## Разбор (по ходу)
- Факт: TS `getNamedDeclarations` (индекс syntactic-пути) НЕ содержит property assignment объектного литерала (`a: 1`, `load: async () => …`) — только method-синтаксис `load() {}`. Сообщение промаха добирает их отдельным обходом файла, иначе счёт «declares N» был ложным (поймано `resolve-line-miss.test.ts` «a destructuring line»). Следствие: `source {syntactic:true}` по name+file такие свойства тоже не адресует — отдельная дыра syntactic-пути (не чинил).
- Факт: go-to-definition по позиции destructured binding / import / контекстно-типизированного члена литерала уходит в другую декларацию, но find_usages/expand_type по той же позиции работают с символом на месте (`resolve-line-miss` col 16). Поэтому line-only в сообщении сформулирован как «go-to-definition там печатает другое», а не «позиция недостижима».
- Проверка self-resolving — LS `getDefinitionAtPosition` на каждый показанный кандидат (≤8), только на пути промаха; брошенный вызов → кандидат по строке, не догадка.
