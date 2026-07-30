---
id: t-810757
title: '`symbols_overview` and `feedback` hard-FAIL in a non-git / non-TS workspace — the two ops that exist to answer "what is here" and "this doesn''t work for me" are the ones that structurally cannot'
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: platform
source: dogfood-jul
relates:
  - t-137057
  - t-287742
  - t-324342
  - t-408918
surface:
  - ops
  - plugins/ts
  - support
audience: external
evidence: repro
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

## Repro matrix on current main — the premise was wider than the fact

Real `/tmp` workspaces through the real binary (A = non-git + TS; B = git + non-TS; C = neither):

| | symbols_overview | search_symbol{syntactic} | source{syntactic} | feedback | status |
|---|---|---|---|---|---|
| A | FAIL tool=git | FAIL tool=git | FAIL tool=git | **ok** | ok (freshness=mtime-walk) |
| B | refusal "no TS project" | refusal | refusal | **refusal** | ok (workspaceError) |
| C | FAIL tool=git | FAIL tool=git | FAIL tool=git | **ok** | ok |

So `feedback` does NOT fail wherever git is missing: `looksLikeTsProject` deliberately does not false-reject a
non-git root (`git ls-files` fails → `return true`). It fails in exactly ONE class — **a git repo with no TS**
(the Spring-Boot shape already visible in `fail.jsonl`). The second-order harm stands unchanged, but it is
narrower than this task's title implies, and the title should be read against this table.

## Two causes, both single points

**A/C** — not `symbols_overview` itself but the shared surface: `plugins/ts/syntactic-surface.ts::surfaceSources`
→ `gitSourceFilesSync`, plus the cache key `syntactic-cache.ts::computeSurfaceKey` (`git rev-parse` +
`git status --porcelain`). Those are the ONLY git dependencies of the whole no-program path (`configMembership`
is host-free, glob-based) — so three ops are fixed at one point.

**B** — `daemon/orchestrator.ts:276` `tsProjectRefusal` cuts at ENGINE SPAWN, before anyone knows which op was
requested. `feedback` declares `requires: []` and touches only `ctx.daemon` (nowMs/version/root/stateDir/
plugins/opNames): no program, no LS, no plugin.

**Hygiene, confirmed:** `runGitSync` (`support/git/run.ts`) sets no `stdio`, so stderr is inherited by the
parent and `fatal: not a git repository` prints three times outside the debug subsystem — which CONTRIBUTING
forbids.

## Decision recorded at the plan gate

Walk-fallback, not a refusal. The decisive argument is not "this op is special": §10 already degrades the TS
program's file set on a non-git root, and §3.5/§19 already degrade freshness to a bounded mtime-walk (which
`status` prints in A/C). The syntactic surface is the ONLY component that hard-FAILs instead of degrading —
so the anomaly is the current behaviour, not the proposed one. A refusal here would also make the redirect
table inert, since other ops' refusals send the agent to exactly these two ops as the ones that answer
anywhere.

The scope statement must change WITH the mechanism, in both directions — including the under-inclusion nobody
would guess: the git listing deliberately does NOT filter by name, while `walkFiles` does, so a real source
file under `build/` is visible in a git repo and invisible in the fallback.

## Мутационная проверка поймала дыру в самой мутационной проверке

Восемь мутаций против новых армов; семь упали сразу. Восьмая — `some` → `every` в
`groupRequiresTsProject` (`daemon/multi-root.ts`, решение гейта по группе диспатча) — **НЕ упала**:
все запросы в тестах шли одним корнем, то есть fast-path'ом `Orchestrator.request`, и ветка
`groupedDispatch` не исполнялась ни разу. Арм на смешанный батч существовал и проходил, но проверял
только fast-path — то есть по multi-root-ветке был декоративным.

Починка: добавлен арм с ДВУМЯ корнями в одном батче (группа неподдерживаемого корня —
workspace-независимая, группа поддерживаемого — обычная), после чего мутация падает. Обе ветки
решения гейта мутированы отдельно и обе дискриминируют.

Факт записан здесь, а не только в отчёте: «мутация не упала» — это не результат «мутация
безопасна», а сигнал, что арм не достаёт до кода. Разница между этими двумя прочтениями и есть цена
проверки.
