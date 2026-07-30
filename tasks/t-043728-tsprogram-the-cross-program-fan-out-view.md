---
id: t-043728
title: TsProgram (the cross-program fan-out view) exposes no configPath, so "is this the no-config fallback primary?" is answered by display-label string equality
status: backlog
priority: medium
tags:
  - dogfood
  - multi-program
type: imp
complexity: S
area: multi-program
source: dogfood-jul
relates:
  - t-162650
  - t-593802
surface:
  - plugins/ts
audience: both
evidence: measured
created: '2026-07-30T13:04:09.764Z'
---
`plugins/ts/program/scan-fanout.ts` `selectScanFanout` must EXCLUDE the no-config fallback primary as a
type authority — the t-593802 reason: its whole-repo DEFAULT-options glob resolves no `paths` and
absorbs `declare global`/`declare module` strays, so a type verdict it produces about a member file is
one the project's own tsconfig never yields.

`TsProgram` (`plugins/ts/program/queryable-program.ts`) exposes `service` / `label` / `getProgram()` /
`fileNames()` / `containsFile()` — but NOT `configPath`, which is the actual discriminator
(`SingleProgram` has it; `TsProgram` deliberately narrows, and the backing type is a structural
superset so widening is free at runtime). So the check is `program.label !== NO_CONFIG_LABEL`, with
`NO_CONFIG_LABEL = '(no tsconfig)'` exported from `program/discover.ts`.

Sound TODAY, and the reasoning is recorded at both sites: `primaryLabel` is the only producer of that
literal and `relLabel` always yields a path, so no real config can collide. The debt is that a
DISPLAY-LABEL string is standing in for a structural fact. Reword the label and the fallback silently
re-enters the fan as a type authority — reporting verdicts computed under DEFAULT options as the
project's own, which is exactly the never-lie violation the exclusion exists to prevent, with no crash
to notice. `test/differential/scan-coverage-honesty.test.ts` pins the BEHAVIOUR (a no-tsconfig repo must
disclose the fallback as unsound), so the failure would now be caught — but by a test asserting prose,
not by the type system.

Fix: add `readonly configPath: string | undefined` (or `isFallback: true`) to `TsProgram`. Zero runtime
cost. `pickTypeAuthority` already takes an `AuthorityProgram` carrying exactly this field, so the two
would then agree BY CONSTRUCTION rather than via two independent proxies for one distinction, and
`NO_CONFIG_LABEL` goes back to being purely a render concern.

Not done in t-162650 because `queryable-program.ts` was held by a concurrent track at the time.

Priority raised medium: the file that blocked the structural fix (`plugins/ts/program/queryable-program.ts`) is now free — the concurrent track that owned it withdrew its own additive change to it, so `configPath` can be added without contention. The label-string proxy is sound TODAY and pinned by a behavioural test, but it is a string-identity stand-in for a structural fact: a rename of the label format survives the test suite and then silently stops excluding the no-config fallback primary, i.e. resumes producing wrong-options TYPE verdicts about member files. That is a never-lie regression with no crash to announce it. `pickTypeAuthority` already takes an `AuthorityProgram` carrying exactly this field, so widening `TsProgram` makes the two agree by construction instead of by two independent proxies for one distinction.
