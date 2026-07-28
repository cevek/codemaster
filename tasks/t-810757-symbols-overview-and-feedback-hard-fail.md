---
id: t-810757
title: '`symbols_overview` and `feedback` hard-FAIL in a non-git / non-TS workspace — the two ops that exist to answer "what is here" and "this doesn''t work for me" are the ones that structurally cannot'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-28T08:23:46.799Z'
---
Three inbox reports from different sessions, none previously converted to backlog (manager's own gap —
tasks were being filed from worker summaries rather than from the inbox itself).

**1. `symbols_overview` dies in a non-git directory** — `FAIL tool=git` / "fatal: not a git repository"
(reported twice, 2026-07-27 19:11 and 19:51). This is the op documented as the OOM-safe first-contact
browse: the thing an agent is told to reach for when it does not know the repo yet, and the redirect
target of the size-guard's own refusal message. It rides the §10 git source surface
(`ls-source-files.ts`), so a workspace without git has no surface and the op throws instead of degrading.
There is already a documented non-git fallback for the freshness path (the bounded stat-walk, §3.5/§19) —
the discovery surface should degrade the same way, or refuse with an honest capability statement, never a
raw `tool=git` failure.

**2. `feedback` is gated behind TS-workspace resolution** (2026-07-27 18:32) — so a repo codemaster does
not support *structurally cannot report that it is unsupported*. The escape hatch for "this tool does not
work here" is itself behind the door it is meant to open, which means the exact population whose
experience we most need to hear is the one that cannot tell us. `feedback` writes to a global inbox and
needs no plugin, no program, no LS — it should resolve before workspace resolution, or fall back to a
root-less record carrying whatever context it does have.

Both are the same shape: an op whose PURPOSE is to work when the normal path does not, failing through
the normal path's own precondition.

Related: t-324342 (non-git freshness degradation), t-408918 (unmeasurable size), and the earlier inbox
wish for JVM/non-TS repos — a non-TS repo today gets neither an answer nor a channel to say so.

## Репро на текущем main + уточнение скоупа (dogfood, 2026-07-28)

Оба пункта воспроизведены; заодно сузился скоуп.

**Не-git корень.** Падает НЕ только `symbols_overview` — те же грабли у `search_symbol {syntactic:true}`, второго OOM-safe пути. Это делает промах системным: обе альтернативы, которые size-guard предлагает в своём же отказе, недоступны на не-git корне.

```
cd /tmp && mkdir cm-nongit && cd cm-nongit          # БЕЗ git init
echo '{"compilerOptions":{"strict":true}}' > tsconfig.json && echo 'export const foo = 1;' > a.ts
node src/bin.ts op symbols_overview '{"summary":true}'              → FAIL tool=git
node src/bin.ts op search_symbol '{"query":"foo","syntactic":true}' → FAIL tool=git
```

В той же директории РАБОТАЮТ: `status` (печатает `freshness=mtime-walk` — то есть non-git fallback уже существует и включён), `search_symbol` (default), `find_definition`, `find_unused_exports`. Значит чинить нужно точечно `surfaceSources` + его фингерпринт, а не freshness-слой.

Гигиена попутно: stderr гита утекает сырьём — `fatal: not a git repository` печатается три раза до самого FAIL, мимо debug-подсистемы (CONTRIBUTING это запрещает; на MCP-транспорте это ещё и шум в канал).

**`feedback` на не-TS репо** — воспроизведено:

```
cd /tmp && mkdir cm-nots && cd cm-nots && git init -q . && echo 'public class A {}' > A.java
node src/bin.ts op feedback '{"kind":"wish","title":"probe","detail":"probe"}'
→ no TS project at /private/tmp/cm-nots — no tsconfig.json and no tracked .ts/.tsx files (…)
```

Цена промаха измерима: в `~/.codemaster/usage/fail.jsonl` лежит потерянная запись (ts=1785177088031, cwd=/Users/cody/Dev/control-plane) — агент на Spring Boot репо (924 `.java`, ~108k LOC) написал развёрнутый wish на JVM-поддержку с разбором пяти задач, ложащихся 1:1 на существующие опы (`find_usages{groupBy:'enclosing'}` для Lombok `.builder()`, `impact` для `@Entity`, `impact_type_error` для nullability при миграции на Kotlin). Текст уцелел только в `fail.jsonl`, до inbox не дошёл — то есть отказ систематически смещает inbox в сторону репо, где всё и так работает.
