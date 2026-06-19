# grep-analysis — когда grep можно заменить на codemaster

Анализ реальных AI-транскриптов (`~/.myclaude/projects/*/sessions/*/transcript.jsonl`):
вытащить все поисковые команды агента (grep/rg/ast-grep/find в Bash + тулы `Grep`/`Glob`)
и классифицировать, какие из них codemaster мог бы ответить лучше (символьный поиск,
i18n-локали, scss, schema) — а какие греп делает правильно (пайп-фильтры, `find`, не-код,
литеральный/regex-текст, не-TS языки).

Итог и правила «форма грепа → op codemaster» — в [FINDINGS.md](FINDINGS.md).
Вердикт по корпусу: ~64% грепов валидны, ~32% заменяемы, ~2% спорных (precision ≈ 95%
на «заменяемых», ручная проверка 20 случайных).

## Скрипты (Python 3, без зависимостей)

| Файл                  | Делает                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `extract_commands.py` | сканит транскрипты → `commands.jsonl` (все tool_use Bash/Grep/Glob) + сводка                                       |
| `classify.py`         | классифицирует поисковые записи → `classified.jsonl` + `samples/<BUCKET>.txt`; `category`/`verdict`/`suggested_op` |
| `sample_repl.py`      | 20 случайных `replaceable` для ручной валидации                                                                    |
| `inspect_i18n.py`     | аудит I18N-бакета (что только локали)                                                                              |
| `audit_ext.py`        | аудит расширений целей в `replaceable` (что только ts/tsx/scss + локальный json)                                   |

## Перегенерация

```bash
python3 extract_commands.py   # пишет в /Users/cody/grep-analysis/commands.jsonl
python3 classify.py           # читает commands.jsonl рядом с собой → classified.jsonl
python3 sample_repl.py        # spot-check
```

Дампы (`commands.jsonl`, `classified.jsonl`, `samples/`) **не коммитятся** — они
генерируемы и содержат тексты команд из приватных чатов. По умолчанию скрипты пишут в
`/Users/cody/grep-analysis/` (исходный рабочий каталог анализа).

## Где это используется

`classify.py` скопирован в глобальный хук Claude Code как `grep_classify.py`:
`~/.claude/hooks/` и `~/.claude-amiro/hooks/`. Хук (`PostToolUse`/`PostToolUseFailure`
на `Bash|Grep`) на каждой «заменяемой» grep-команде впрыскивает в контекст агента
подсказку «юзай codemaster MCP». Правишь правила здесь — **перекопируй** в оба хук-каталога
(единого источника пока нет; копии независимы ради устойчивости).
