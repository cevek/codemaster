---
id: t-698933
title: 'move_symbol/extract_symbol: type-позиционные ссылки через namespace-импорт (M.Model, typeof M.fn) не переписываются — перенос отказывает'
status: todo
priority: high
parent: t-116306
tags:
  - mutation
  - namespace
type: bug
complexity: M
area: ts-refactor
evidence: repro
author: c37d629d
created: '2026-10-03T16:26:41.811Z'
---
Consumer `import * as M from '../model.ts'` использует перенесённый символ в TYPE-позиции: `M.Model` (тип) или `typeof M.setName`. LS «Move to file» (апстрим TS 6.0.3, `updateNamespaceLikeImport`) переписывает только рефы, чей родитель — PropertyAccessExpression; QualifiedName пропускается. Итог: `Namespace has no exported member 'Model'` / `Property 'setName' does not exist` — гейт честно отказывает, но перенос типа, которым пользуются через namespace, невыполним.

Repro (разбор t-932492, фикстуры S14/S15): move_symbol Model из src/feat/model.ts в существующий src/feat/types.ts при consumer `function run(m: M.Model)`; move_symbol setName при `export const f: typeof M.setName = M.setName`. Во втором случае LS вставил импорт dest и переписал value-реф, а typeof-реф остался висеть.

Минимальный исход: в нормализаторе namespace-импорта (`reconcileNamespaceImports`, src/plugins/ts/refactor/imports/reconcile-namespace-import.ts, t-932492) дописать QualifiedName-рефы на перенесённые символы к выбранному alias dest, когда LS вставку сделал. Развилка (ниже, не решена): все рефы типовые → LS не вставляет импорт вовсе, нужна генерация спецификатора.


## Разбор (repro, TS 6.0.3)

Фикстуры: model.ts (`interface Model`, `setName`, `keep`), dest `src/types.ts`, consumer `src/ui/use.ts`; dry-run `move_symbol … dest:src/types.ts`.
- (a) consumer только с типовыми рефами `m: M.Model` (move Model) → LS consumer не трогает вовсе (нет вставки), гейт: `Namespace … has no exported member 'Model'` ×2.
- (b) `typeof M.setName = M.setName` (move setName) → LS вставил `import * as types` и переписал value-реф, `typeof M.setName` висит.
- (c) t-647916: dest сам `import * as M from './model'` + `M.setName(...)` → LS dest-рефы не трогает (`updateImportsInOtherFiles` пропускает файл, совпадающий с target), гейт: `Property 'setName' does not exist`.
- (d) t-132219, `import M = require('../model')` (module: commonjs), preferred-имя свободно → чисто, LS эмитит `import types=require("../types")`.
- (f) то же, но в файле `const types = 2` → `Import declaration conflicts with local declaration of 'types'` + `Cannot find name 'types_1'` — **t-132219 воспроизведён**, evidence→repro.
- (e) `const M = require('../model')` в `.ts`: `M` = any, LS форму не обслуживает — недостижимо. В `.js` под allowJs+checkJs (g): расхождение есть (вставка — фрагмент декларатора `, types=require(…)`, не statement), но гейт `.js` не проверяет вовсе — заведено t-995202 (гейт говорит clean на дереве, где tsc даёт 2 новые ошибки). JS-форма в скоуп не берётся.
- Capture-гейт move/extract (`declImportsName`, `refactor/capture/move-symbol.ts`) ns-импорты пропускает намеренно → синтезированная вставка ns-импорта в паритете с LS-вставкой, не регресс.
- Апстрим: `updateNamespaceLikeImport` фильтрует рефы `isPropertyAccessExpression(ref.parent)`; QualifiedName (`M.Model`, `typeof M.x`) не видит ни для переписывания, ни для `needUniqueName`.

## План

**Скоуп.** `refactor/imports/reconcile-namespace-import.ts` (расширение) + новые модули рядом при выходе за 300 строк; новый пост-apply нормализатор dest `refactor/normalize/collapse-dest-namespace.ts` (t-647916); `refactor/imports/emit.ts` — аддитивный вариант `emitSpecifier`, принимающий путь цели строкой (2 текущих потребителя `rewrite.ts`/`rebase-ambient.ts` байт-в-байт); вызовы в `extract/move-to-existing.ts`, `extract/move-to-file.ts`. Гейт (`program-gate*`, `single.ts`, `diagnostics.ts`) не трогаю.

**1. Consumer (t-698933 + t-132219), edit-уровень до apply, как сейчас.** Нормализатор получает перемещённый `stmt` + source sf и колбэк спецификатора. Перемещённые символы = декларации `stmt` (через `checker.getSymbolAtLocation(name)`), без internal `skipAlias`: реф `M.x` перемещён, когда символ `x` объявлен в source внутри `stmt`.
- Кандидаты: файлы программы (не source, не dest) с top-level ns-like импортом source — `import * as M` или `import M = require(...)`. Синтаксический префильтр без чекера: есть `M.<имя из stmt>` (PropertyAccess с `expression===M` или QualifiedName с `left===M`) — иначе файл не трогается и чекер не строится (сохраняется ленивость из t-932492 при pre-strip). Резолв спецификатора в source — чекером, только для прошедших префильтр.
- Рефы файла R = LS-переписанные PA-рефы (из `fc.textChanges`, как сейчас) ∪ собственные: QualifiedName-рефы на перемещённые символы (LS их не видит).
- Имя T для dest в файле:
  1) существующий ns-like импорт dest K (ImportDeclaration ns или ImportEquals require; резолв по идентичности SourceFile) и в каждом рефе R `resolveName(K)` даёт символ импорта (meaning: Value|Namespace для PA, Namespace для QN). `import type * as K` годится, только если все рефы типовые. → рефы в K, LS-вставка снимается;
  2) LS-вставка есть (имя P, рефы Y): как сейчас согласовать вставку на Y; плюс QN-рефы → Y, если Y на каждом QN-сайте не затенён (Y≠P файл-уникален по getUniqueName; Y=P проверяется `resolveName`); затенён → свежее файл-уникальное имя для вставки и всех рефов;
  3) вставки нет (все рефы типовые, кейс a) → **генерация** вставки после импорта M той же формы, что эмитит LS (`import * as T from '<spec>'` / `import T = require('<spec>')`; type-only наследуется от M), спецификатор — `emitSpecifier` от спецификатора M (алиас/расширение сохраняются), кавычки — стиль M (`emitQuoted`), имя — basename dest → валидный идентификатор, файл-уникальный (скан идентификаторов) и не резолвящийся на сайтах. Файл без LS-правок получает синтезированный `fc` → существующий apply-цикл (untracked-файл → существующий честный отказ).
- `namespaceInsertion` распознаёт и `ImportEqualsDeclaration` с `ExternalModuleReference` (t-132219), `nameStart` из `stmt.name`.
- Неопределённость (две ns-вставки, две разные Y, ...) → fc байт-в-байт, гейт — бэкстоп (как сейчас).

**2. Dest (t-647916), пост-apply текстовый нормализатор**, вызов из `move-to-existing.ts` после apply рядом с `stripSelfImports` (у extract dest новый — ns-импорта source быть не может). Работает на тексте, который реально лёг в узел (pre-strip не мешает: смещения считаются по пост-тексту). `M` = ns-like импорт dest-файла, чей спецификатор резолвится в source (тот же лексический/алиас-резолв, что `stripSelfImports`, + `resolveSpecifierToNode`). `M.<moved>` (PA и QN) → голый `<moved>`. Затенение — синтаксически, консервативно: любая декларация с именем `<moved>` в dest на любой глубине, кроме самого перенесённого statement'а и (снятого pre-strip) импорта → не трогаю ничего, гейт откажет как сегодня. У `M` не осталось рефов → импорт снимается (`deleteWholeLine`).

**Развилка «все рефы типовые»:** генерация, а не отказ. Детекция у отказа и генерации одна и та же (обход consumer'ов + QN-рефы); дельта генерации — имя (6 строк) + одна вставка, спецификатор — существующий шов `emitSpecifier`, форма узла — LS-овская. Честный отказ стоил бы ~70% той же работы ради худшего исхода. Альтернатива для имени — internal `ts.moduleSpecifierToValidIdentifier` — отвергнута: требует §4 boundary + capability-guard, а паритет с LS-именем не нужен (переиспользование идёт по идентичности модуля).

**Развилка dest: пост-apply текст vs edit-уровень с чекером.** Выбран пост-apply: под pre-strip LS считал dest-правки против вытесненного текста, смещения захваченной программы для dest неверны; синтаксическая консервативная проверка затенения — недо-переписывание в худшем случае, гейт ловит.

**Доказательство поведения** — `test/e2e/move-namespace-import.test.ts` (206 строк → новые случаи в соседний файл), оракул: cold-диагностика пост-дерева после apply + структурный `nsView` (расширить `boundTo` на QualifiedName через `n.right`):
- (a) move_symbol типа при только типовых рефах → чисто, `M.Model` привязан к dest; то же для extract_symbol;
- (b) `typeof M.setName` + value → чисто, оба рефа в dest, один импорт dest;
- (a+reuse) типовые рефы + consumer уже `import type * as I from dest` → рефы в I, новых импортов нет;
- QN-затенение: `type types = …` на сайте QN при Y=P → реф не уходит в затенённое имя, чисто;
- (c) t-647916 → чисто, в dest нет `M.setName`; вариант, где все рефы M ушли → импорт M снят; вариант с затеняющим параметром `setName` → не переписан (гейт отказывает — ассерт на отказ);
- (f) `import = require` + занятое имя (commonjs tsconfig) → чисто;
- transaction: extract типа + move в тот же dest, consumer только с типовыми рефами → один импорт dest.
Мутации: выключить по одному новому guard'у (QN-сбор, генерация, require-форма, dest-нормализатор, shadow-проверки) → краснеет ровно свой ассерт. Живая проверка: a/b/c/f из `/tmp/ns698` dry-run + цепочка t-749107 на amiro (только чтение).

**Doc:** заголовок `reconcile-namespace-import.ts` и абзац ARCHITECTURE §4 «namespace-import reconcile» — present-state под новое поведение (их делает ложью эта правка).

**Ревьюверы на код:** bug-reviewer (до двух кругов по правилу брифа).

**Закрытие:** t-647916, t-132219 → закрываются ссылкой на t-698933 (t-132219 сжат до ImportEquals-формы; JS `const = require` — в t-995202).



## Пауза
Трек остановлен до начала кода при закруглении эпика t-116306. План на 3c4fcae — plan-ревью при возобновлении гнать заново. Capture-гейт ns-вставки не проверяет (`declImportsName` в `capture/move-symbol.ts` пропускает ns намеренно) — и LS-вставки, и сгенерированную ловит только typecheck-гейт.
