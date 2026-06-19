# Grep → codemaster: классификация и правила

Корпус: **455** транскриптов (`~/.myclaude/projects/*/sessions/*/transcript.jsonl`),
**25 020** извлечённых tool_use (`extract_commands.py`), из них **13 410** поисковых
(grep/rg/ast-grep/find в Bash + дедицированные тулы `Grep`/`Glob`).

Классификатор: `classify.py` → `classified.jsonl` (+ `samples/<BUCKET>.txt`).

## Итог

| Вердикт         | Доля             | Что значит                                             |
| --------------- | ---------------- | ------------------------------------------------------ |
| **valid**       | **64 %** (8 669) | греп — правильный инструмент, codemaster не лучше      |
| **replaceable** | **33 %** (4 439) | можно/нужно советовать op codemaster                   |
| ambiguous       | 2 % (302)        | цель не доказана — оставляем гепу (precision > recall) |

Принцип (из ARCHITECTURE «never lie»): при сомнении — **valid**. Переусердствовать с
рекомендацией там, где codemaster не сделает лучше, — ровно та ложь, ради борьбы с
которой инструмент и существует.

## Разделитель — ФОРМА ПАТТЕРНА, не расширение файла

Внутри `.ts/.tsx` решает не файл, а паттерн:

- **идентификатор** или **альтернация идентификаторов** (`\w`-токены, опц. `\b`-границы,
  без якорей/классов/квантификаторов/точек/пробелов) → **символьный поиск → codemaster**.
  Примеры: `refUuid`, `BookAppointmentInputDto`, `useTasks\|useCreateTask\|useDeleteTask`,
  `BOOKED|CONFIRMED|ARRIVED`.
- паттерн с метасимволами / member-access / URL / JSX-разметкой → **литеральный/структурный
  текст → valid греп**. Примеры: `task\.id`, `<StatusBadge`, `status=\{appt\.status`,
  `tasks/search`, цветовые хексы `fef3c7|ccfbf1`.

Единица классификации — **первый греп, читающий ФАЙЛЫ** (не stdin). Если все гепы в команде
читают из пайпа (`ls | grep`, `diff | grep`, `git log | grep`) → это фильтр вывода → valid.

## Правила «форма → op»

| Сигнал в гепе                                                            | → op codemaster                         | объём |
| ------------------------------------------------------------------------ | --------------------------------------- | ----- |
| идентификатор по `.ts/.tsx`/`src/`, режим content                        | `search_symbol` / `find_usages`         | 2 838 |
| идентификатор + `-l` / `files_with_matches` («какие файлы используют X») | `find_usages` / `importers_of`          | 575   |
| цель — `locales/**` или i18n-JSON                                        | `find_unused_i18n_keys` / `i18n_lookup` | 656   |
| цель — `*.scss` / `*.css`                                                | `find_unused_scss_classes`              | 240   |
| цель — `schema.d.ts` / эндпоинт-паттерн                                  | `list_endpoints` / `search_symbol`      | 130   |

Сильнейший питч codemaster — `-l`/`files_with_matches` по идентификатору: «в каких файлах
используется X» = `find_usages`/`importers_of`, и он ловит **алиасные импорты и JSX**
(`import {Foo as F}` … `<F/>`), которые греп пропускает.

## Где греп оставить (valid) — НЕ советовать codemaster

- **Пайп-фильтр** (16 %): греп по stdout (`… | grep`, `diff | grep`, `git log | grep`).
- **Поиск файлов** (11 %): `find -name/-path`, `Glob`-тул — это файловая навигация, не
  семантический op.
- **Не-код / не-TS** (8 %): `/tmp/`, `.log/.txt/.md/.diff`, `node_modules`, `dist/`,
  и **другие языки** (`.java/.py/.go/.kt/…`) — codemaster чисто TS/React.
- **Литеральный/структурный текст по коду** (27 %, CODE_TEXT): member-access (`obj\.prop`),
  JSX-разметка, regex с `.*`/якорями/классами, URL-пути, цветовые токены. (Часть из них —
  JSX `<Component`, структурные переписывания — кандидаты на `codemod`/`find_usages`, но
  паттерн с метасимволами оставлен консервативно valid.)

## Валидация replaceable (ручная, 20 случайных)

Выборка 20 случайных `replaceable` (seed=42, `sample_repl.py`), проверено вручную:
**19/20 — действительно заменяемы.** Один ложноположительный:

```
grep -r "satisfies" src | wc -l        # satisfies = TS-keyword, не символ; wc -l = метрика
```

→ исправлено стоп-листом TS-ключевых слов (`satisfies/keyof/typeof/string/number/...`):
паттерн из ОДНИХ ключевых слов больше не считается символьным (replaceable 4439→4422).
Оценочная precision на replaceable ≈ **95 %** (1 явный промах + 1–2 пограничных
mixed-intent, напр. альтернация, где имя TS-символа соседствует с именем БД-таблицы).

## Аудит целевых типов файлов в replaceable (4 419)

| ext                                      | кол-во | домен                                                                            |
| ---------------------------------------- | ------ | -------------------------------------------------------------------------------- |
| ts / tsx / d.ts                          | 2 756  | TS ✅                                                                            |
| json                                     | 520    | **только локали** (en.json 511 + ru/de/es) — не-локальный JSON уходит в NON_CODE |
| scss / css                               | 276    | SCSS ✅                                                                          |
| js / jsx                                 | 8      | все в include-наборе вместе с `*.ts/*.tsx` (домен TS обоснован, .js — довесок)   |
| без расширения (рекурсивно по папке/cwd) | 1 345  | TS-репо; codemaster типизирован → находит usages без фильтра расширений          |

Подтверждено: в replaceable JSON попадает **только через i18n-локали** (`по json — только
en.json`). JS-конфиги (`*.config.{js,mjs,cjs}`, `webpack*/eslint*/orval*/vite*…`) вынесены в
NON_CODE — TS-плагин их не индексирует (не в tsconfig).

## Артефакты

- `extract_commands.py` — выгрузка команд из транскриптов → `commands.jsonl`.
- `classify.py` — классификатор → `classified.jsonl` + `samples/`.
- `commands.jsonl` (25 020) / `classified.jsonl` (13 410 поисковых, с `category` /
  `verdict` / `suggested_op`).
