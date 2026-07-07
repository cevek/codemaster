---
id: t-000092
title: "ambient-rebase neither-resolve residual"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:31.000Z'
---
**ambient-rebase neither-resolve residual** — `imports/rebase-ambient.ts` rebases a new-file
ambient import (`*.module.scss`) only when it resolves from SOURCE but not from DEST. A
PATH-RELATIVE ambient import whose sheet lives in an UNTRACKED source file resolves from neither,
so it is not rebased and stays broken from `dest` — and the ambient `declare module '*'` keeps the
§2.8 typecheck clean, so no error surfaces. Narrow (needs a relative ambient import of an untracked
sheet); close by also probing the source dir for an on-disk (untracked) sheet. `bug`·`low`·`cx:S`
