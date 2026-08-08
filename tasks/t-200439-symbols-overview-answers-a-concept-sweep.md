---
id: t-200439
title: symbols_overview states no scope on its output, so "1 name" from a concept sweep reads as "1 site" — a false absence from the documented first-contact op
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
  - honesty
type: feat
complexity: S
area: ts-core
source: dogfood-inbox-aug
relates:
  - t-288409
  - t-531398
  - t-543956
  - t-647309
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:06:02.725Z'
---
`symbols_overview` is the documented first-contact op, and a first-contact question is usually about a CONCEPT ("where does this codebase handle X"), not about a declared name. The catalogue indexes top-level declaration NAMES — so a concept whose handling lives in discriminant-union members, `case` string literals, object keys and non-exported locals returns almost nothing, and **nothing on the output says so**.

That silence is the defect this task owns. A bare `1` is read as "one site" when it means "one exported top-level declaration whose NAME matches", and the reading error is in the direction of a FALSE ABSENCE — the agent concludes the repo barely touches the concept and stops looking. `exportedOnly` defaults on; `all:true` widens to non-exported declarations but still cannot see a `case 'thinking'` arm or a `{kind:'thinking'}` union member.

This is the same class the rest of the tool already treats as non-negotiable: a filtered or partial answer that does not name its own filter reads as a whole one. The op's own siblings state their scope (the syntactic search declares its under-root limit; the scans state files-walked-of-files-held); the first-contact browse — the one op most likely to be someone's ONLY call — states nothing.

## The ask (cheap, honesty-only)

One scope line on the output: the catalogue is DECLARATIONS-ONLY, so N names is not evidence of N sites — string-literal case labels, discriminant union members and object keys are not indexed. It ships independently of any indexing work and removes the false-absence reading immediately.

The CAPABILITY half — actually indexing those literals so a concept sweep finds them — is `t-543956` (parented under the literal-as-identity umbrella `t-560034`), carrying both field reports. The two are deliberately split: the scope line is small, honesty-critical and shippable now; the index is a real feature. Do not close one as the other.

## Свидетельство (field report, 2026-08-04, /Users/cody/Dev/claude-ui)

External agent, sweeping the "thinking" concept. Per the spec it started with `symbols_overview {query:'thinking'}` → exactly ONE name: `ThinkingTrace`. Real handling sites: `onSystem`'s `case 'thinking_tokens'` and the `case 'thinking'` arm in `parseBlocks` (`packages/chat-model/src/model.ts`), the `thinking: {type:'adaptive'}` query option and the `'thinking_tokens'` case in `toChatMessage` (`packages/agent-anthropic/src/index.ts`), the `{kind:'thinking'}` union member (`packages/chat-model/src/types.ts`).

Reporter: "the first-contact op said 'there is one thinking-related thing in this repo', which is materially misleading for a concept sweep" — then fell back to `grep -rn "thinking"`, which found all of it in one call, "exactly what the spec asks agents not to do".

A second report from the same wave (`/Users/cody/Dev/customer-frontend-v2`, 2026-08-03) hit the exported-surface limit from the other side: 3 names returned for a file declaring ~60 internal symbols. That half is filed as `t-531398` (file-scoped orientation).
