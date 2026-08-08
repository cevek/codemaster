---
id: t-531398
title: 'A file path is the handle an agent usually holds first, and no op takes it: orienting inside one file (or a file too large to Read) has no codemaster path at all'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: feat
complexity: M
area: ts-core
source: dogfood-inbox-aug
relates:
  - t-229522
  - t-708735
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:05:36.773Z'
---
Every symbol-addressed op requires a symbol NAME or a position. The handle an agent actually holds first is a
PATH — from a stack trace, an import, a grep-ish hit, or a task description. There is no op that turns a path
into structure, so the first question of any orientation ("what is in this file?") falls outside the tool, and
the fallback is Read/cat — the thing codemaster exists to replace. Where the file is too large to Read, there
is no fallback at all except grep/awk.

Concretely missing, all one gap:

- **`source` refuses a bare `{file}` target** — "pass 'symbolId', or 'name', or file+line (col optional)".
  A line or a name is exactly what the caller is trying to LEARN.
- **`symbols_overview` has no file scope** — `query` matches NAMES, not paths, so "what's in THIS file" is
  inexpressible, and `all:true` widens to the whole repo.
- **No op reports declaration SIZE** (line span), so "which symbol is the 10k-line one" is unanswerable.
- **No ordering / nesting**, so the internal shape of a file is invisible even when its names are listed.

## Ask

A `file_outline {file}` op — the ordered declarations of ONE file with line ranges, kind, exported flag and
nesting depth (and, where the react plugin is active, hook count per component). That is the
"I cannot Read this file, orient me" primitive. It should be a no-program syntactic path like
`source {syntactic:true}` (`t-229522`): the question needs no checker, and the files that most need it are in
the repos where a program build is least affordable.

Two smaller pieces of the same gap, worth doing with it:
- accept a bare `{file}` target in `source`, returning the bodies of the file's top-level declarations;
- a `file:` / path scope on `symbols_overview`.

And a refusal-doctrine item (`t-259465`): `source`'s bad_args message lists the accepted target forms but
names no next step for the "I only have a path" case. Until the outline exists it should name the call that
does help; once it exists, it should name that.

## Свидетельство (two field reports)

**2026-08-03, `/Users/cody/Dev/customer-frontend-v2`.** Task: "read `src/components/PatientRecord.tsx` and
tell me what you think" — **11,727 lines / 561 KB, over the Read cap**, so file-reading was not an option and
codemaster was the only path. `symbols_overview {query:'PatientRecord'}` returned exactly 3 names, because it
is exported-surface-only; the file actually declares ~60 internal types / helpers / subcomponents plus 96
`useState` calls inside one 10k-line function body. The agent fell back to grep/awk for every structural fact:
where the top-level decls are, where the main function starts (1158), where its JSX return starts (11217), how
many hooks, whether subcomponents are nested. Reporter: "that is exactly the symbol identity/structure question
the tool is supposed to own, and grep answered it while codemaster could not."

**2026-07-30, `/Users/cody/Dev/task-manager`.** `source {targets:[{file:'web/src/detail/BodyField.tsx'},
{file:'web/src/ui/InlineMarkdown.tsx'}]}` → hard-fail `bad_args`, forced fallback to Read/cat. The agent was
orienting in an unfamiliar area and had only paths.

Both external agents in repos they do not maintain.
