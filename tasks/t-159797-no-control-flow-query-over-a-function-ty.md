---
id: t-159797
title: No control-flow query over a function-typed ARGUMENT — "which callbacks passed to X complete WITHOUT reaching the awaited call" is the question framework contracts turn on, and only human reading answers it
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-045024
  - t-100043
  - t-278380
  - t-849286
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-07-28T08:27:58.675Z'
---
Track: moving a popup's unsaved-changes reset from the submit EVENT to the actual commit. The entire risk
was one enumeration — which `useAppForm` consumers RESOLVE their `onSubmit` without having committed
anything — because the new contract keys a guard reset, a success toast and the popup close off that
resolve.

codemaster answered the structural half well and fast: `find_usages` for the JSX call sites of each
delegating dialog, `source` for N handler bodies in one round-trip, `search_symbol` to prove a name the
docs still cited was dead.

What had to be done by hand — and what two review agents found first: read every consumer's `onSubmit`
body and classify it "resolves ⇒ committed" or not. Four handlers had a bare `return` on a defensive
guard; two more caught their own error without rethrowing. grep cannot express it, and `find_usages` does
not look inside the callback.

Wish: a control-flow query over a function-typed argument, e.g.
  `resolution_paths { symbol:'useAppForm', argPath:'onSubmit' }`
returning, per call site, the callback's terminal statements classified as
`throw` / `return-value` / `bare-return` / `await-then-return` / `catch-without-rethrow`, with proof spans.
Even a crude version (callbacks + `return` statements not preceded by an `await` in the same block) would
have surfaced all six in one call.

The general shape — "for every callback passed to X, which exits complete WITHOUT reaching the awaited
call" — is what you need whenever a framework contract says "resolving means you did the thing": commit
chains, retry wrappers, transaction helpers, anything with an `onSuccess`. `discrimination_sites` is the
nearest existing op (exhaustiveness over a union); this is the same instinct applied to a callback's exit
paths.

Second, smaller: `member_usages` on a specific option KEY of an options-object argument — every call site
passing `wrap:false` / omitting `resetOnSuccess` — would give the opt-out census directly. It was obtained
by grep only because those key names happen to be unique strings; on a generic key (`mode`, `enabled`)
there is no way to ask.

## The named handlers are HISTORICAL — and this one is worse than stale coordinates

`SendFormBody`, `AddLabPanel`, `EditWorkspaceFormInner`, `EditOrganizationFormInner`, `AmendmentComposer`
were classified mid-track, in a repo under active editing (amiro, ~3 days before filing). Two compounding
reasons not to treat them as a repro list:

1. line offsets have moved;
2. **that track's entire purpose was changing the very contract these handlers were classified against**
   — moving the unsaved-changes reset from the submit event to the actual commit. So some of these
   handlers were plausibly reworked by the same work that surfaced them. A worker starting from this list
   may be auditing code that no longer has the property described.

Re-derive by name against current HEAD before drawing any conclusion. What is durable is the QUESTION —
"for every callback passed to X, which exits complete without reaching the awaited call" — and the fact
that it took human reading plus two review agents to answer once. The op proposed here is justified by the
shape of the question, not by the survival of these five instances.

Origin sessions (archived, worktrees gone — read the transcript via MCP, do not message them):
`~-Dev-amiro/sessions/caf41ed2` and `~-Dev-amiro/sessions/59949227`.
