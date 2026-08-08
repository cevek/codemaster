---
id: t-543956
title: symbols_overview catalogues DECLARED names only, so in a message-driven codebase the feature surface — string members of discriminated-union protocols — is invisible to the first-contact browse
status: backlog
priority: high
parent: t-560034
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: ts-core
source: dogfood-inbox-aug
relates:
  - t-288409
  - t-966927
audience: external
evidence: reported
created: '2026-08-08T12:03:09.891Z'
---
## What is missing

`symbols_overview` is the first-contact orientation browse, and its catalogue is built from DECLARED
symbols. In a message-driven / protocol-driven codebase the surface of a feature is not declared symbols: it
is the string members of a discriminated union (`'delete_worktree'`, `'start_vite'` as discriminants of a
`ClientMessage` type), plus props and local state bindings. A `query` narrowing over the declared catalogue
therefore reports a feature as nearly absent while its real surface sits one AST level below, and the
orientation call — the one whose whole job is "what is here on topic X" — sends the agent to grep.

Ask, in order of value:

1. index the members of string-literal union types as searchable NAMES, especially the discriminant literals
   of message / action types;
2. optionally admit non-exported props and local bindings into the fuzzy match (`all:true` exists but its
   description scopes it to locals, not to literals).

This is the "what counts as a symbol at all" axis of `symbols_overview` coverage; it is orthogonal to the
visibility axis (exported vs non-exported surface), which is tracked separately.

## Свидетельство

2026-08-02, `/Users/cody/Dev/claude-ui`. Task: find the UI + protocol surface of the "worktree" feature.
`symbols_overview {query:'worktree'}` returned only `createWorktree` / `removeWorktree` (apps/server),
because that is the catalogue of exported declarations. The real surface: string literals in the
discriminated union `ClientMessage` (`'delete_worktree'`, `'start_vite'`), props and local state
(`worktreeName`, `worktreeEnabled`), and JSX text. All invisible — the agent fell back to grep twice.

The reporter's framing: for message-driven codebases, "what ops / messages exist on topic X" is a frequent
FIRST question of an agent, which makes it exactly the question the orientation op is supposed to own.

## Второе независимое свидетельство (та же способность, другой репозиторий и другой концепт)

2026-08-04, `/Users/cody/Dev/claude-ui`, внешний агент. Задача — найти все места обработки концепта «thinking».
`symbols_overview {query:'thinking'}` вернул РОВНО ОДНО имя (`ThinkingTrace`), тогда как обработка живёт в
`case 'thinking_tokens'` / `case 'thinking'`, в члене union `{kind:'thinking'}` и в ключе опции `thinking:`.
Агент ушёл в `grep -rn "thinking"`, который нашёл всё за один вызов.

Итого два независимых репорта из двух репозиториев на одну и ту же недостающую индексацию: дискриминантные
литералы union и строковые метки `case` не являются искомыми именами, хотя семантически в TS они И ЕСТЬ символ.

Честностная половина того же наблюдения — что ответ не сообщает о своём скоупе, из-за чего `1` читается как
«одно место», — вынесена в t-200439: она дешёвая, чинится независимо от индексации и должна приехать раньше.
