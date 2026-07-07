---
id: t-000167
title: "exit-seam masking test: orphaned `.gen.ts` child swept only on the NEXT run"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:46.000Z'
---
**exit-seam masking test: orphaned `.gen.ts` child swept only on the NEXT run** — `exit-seam-
masking.test.ts` generates a pid-unique `exit-seam-child.<pid>.gen.ts` under `test/e2e/`, cleaned in
`finally` + a defensive sweep at the START of the next run. A hard-kill (SIGKILL) between generation
and cleanup leaves a stray `.gen.ts` that an independent `npm run check` (tsc -p tsconfig.test.json /
eslint `test/**/*.ts`) would glob before the next test run sweeps it. Narrow window, abs-path import
stays valid, low risk. Consider generating under `os.tmpdir()` instead, or a sweep in the check
script. `dx`·`low`·`cx:S`
