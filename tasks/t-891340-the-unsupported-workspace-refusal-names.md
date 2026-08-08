---
id: t-891340
title: 'The unsupported-workspace refusal names a lever it cannot certify: "add a codemaster.config to opt in" leaves the agent unable to tell whether ANY config makes a non-TS repo answerable, so first contact is a dead end'
status: backlog
priority: high
parent: t-259465
tags:
  - agent-surface
  - dogfood
  - honesty
type: dx
complexity: S
area: render
source: dogfood-inbox-aug
relates:
  - t-245013
  - t-810757
  - t-815425
surface:
  - daemon
  - ops
  - ops/guard
audience: external
evidence: repro
created: '2026-08-08T11:59:54.405Z'
---
A root with no `tsconfig.json` and no tracked `.ts/.tsx` is refused by the TS-project gate
(`daemon/ts-project-check.ts`) with:

> UNSUPPORTED WORKSPACE: no TS project at &lt;root&gt; — no tsconfig.json and no tracked .ts/.tsx files
> (codemaster inspects TypeScript/React repos; point at a TS repo root, or add a codemaster.config to opt in)

The refusal is truthful about the STATE and unusable as a NEXT STEP, which is the defect this epic exists
for (§9 / `ops/guard/navigate.ts`: a refusal names a call the agent can make HERE).

Two failures in one message:

1. **The named lever is uncertifiable by the reader.** "add a codemaster.config to opt in" is true of the
   gate (an explicit config is trusted and bypasses the refusal) and says nothing about the OUTCOME: past
   the gate, every plugin is still TS-shaped, so a markdown-only repo gains an engine and no answerable op.
   An agent cannot tell "config would make this repo work" from "config only silences the gate". Under the
   first reading it edits a repo it may not own; under the second it wasted the call. Naming a lever whose
   effect on the outcome is undetermined is the same class as naming an inert one.

2. **There is no fallback statement.** The one thing that IS certain here — this corpus has no inspectable
   surface, use grep/Read — is the thing the message does not say. The repo's own agent instructions route
   every identity/reference question through codemaster, so the agent arrives, is refused, and has to
   INFER the fallback rather than read it.

Fix shape, no new capability: state the certain part positively ("no inspectable surface here — use
grep/Read for this repo"), and make the config clause honest about scope — a config opt-in changes the
GATE, and the active plugins are TS/React, so a non-TS corpus stays unanswerable until a plugin for its
domain exists (t-815425). The sibling form of the same defect is the plugin-unavailable message
(t-245013): it also names what is missing and not the activation rule.

## Свидетельство (field reports, /Users/cody/Dev/amiro-brain — pure-markdown spec corpus, external agents)

- 2026-08-03 — «when no TS is found, say whether a config opt-in exists that would make any op work, rather
  than only pointing at "point at a TS repo root" — **I could not tell from the message whether
  codemaster.config would help a non-TS repo or not**.»
- 2026-08-02 — «`status` correctly reports "no TS project". But the repo's agent instructions say to default
  to codemaster for every symbol/usage question, so an agent burns a call discovering there is nothing to
  inspect. Wish: let `status` say plainly "this repo has no inspectable surface — use grep/read" so the
  fallback is explicit rather than inferred.»
- 2026-08-01 (×2) — same refusal observed, each time recorded as an honest failure with no path forward.

Four reports, one external repo, three sessions. The capability half of these reports is t-815425.

**Reproduced on current `main`, 2026-08-08** — `node src/bin.ts status --root /tmp/cm-md-probe` (a git repo
holding one `.md`, no tsconfig, no `.ts`):

```
workspace: none resolved — no TS project at /private/tmp/cm-md-probe — no tsconfig.json and no tracked
.ts/.tsx files (codemaster inspects TypeScript/React repos; point at a TS repo root, or add a
codemaster.config to opt in)
```

Both halves confirmed live: the config clause is present with no statement of what it changes, and there is
no "no inspectable surface here — use grep/Read" fallback anywhere in the response.
