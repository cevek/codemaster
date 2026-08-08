---
id: t-762238
title: 'The generated-client conventions are machine-readable in the tree and unreachable through any op: operationId → hook → hand-written override → mock handler → callsites is re-derived by grep or a one-off script every time, and `list_endpoints` is inert because the schema plugin is inactive'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: schema
source: dogfood-inbox-aug
relates:
  - t-245013
  - t-731041
surface:
  - ops
  - plugins/schema
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:01:37.872Z'
---
In a repo with an openapi-generated client, the unit of work for backend-contract tasks is the OPERATION, not
the symbol. No op is addressed by one, and the four places an operation lives are wired by CONVENTION —
exactly the kind of fact an indexer can assert instead of having each agent re-derive it:

- `operationId` → its generated call surface (`api.<operationId>` — a PROPERTY of one giant generated object
  literal, so `find_usages` on a symbol is not the question; `member_usages` may cover it and nothing points
  there, see the discoverability sibling),
- → its generated hooks (`useX` / `useSuspenseX` / `useXQueryOptions`),
- → its hand-written override in `src/api/hooks/` if one shadows the generated hook ("which operations have a
  hand-written override" was answered by reading a doc comment),
- → its mock handler in `src/local-api/handlers/` (matched today by regexing url patterns out of
  `src/api/generated/api.ts` and `local-handlers.ts`).

`list_endpoints` is the one candidate op and it answers "needs plugin(s) [schema] which are not active in this
workspace" while the source of truth — the generated client — is in the tree and machine-readable. Two asks
follow: (a) endpoints as a table `{operationId, method, path}` off the GENERATED CLIENT, not only off an
openapi entrypoint the schema plugin is configured with; (b) the reverse direction, "which symbol/file
implements operationId X", which in these repos has TWO bodies (generated client + mock handler) and so is
asked constantly. With a table on each side, `sql` closes the whole class ("back × mock sweep") in one call:
`FROM endpoints JOIN handlers ON operationId`.

The refusal half of this is t-245013: the message names the missing plugin and not what activates it, so an
agent facing a repo that HAS the surface cannot tell "not applicable" from "not configured".

## Свидетельство (field reports, external agents, repo amiro-frontend)

- 2026-08-05 — comparing the mock server's default sort (~38 `paginate(...)` sites) against the java backend's
  `@PageableDefault` needed the bridge handler-key → method+url. Nothing answered it; wrote a one-off node
  script (regex over `api.ts` + regex over the handlers) — «ровно тот класс работы, ради которого codemaster и
  заводят».
- 2026-08-07 — a whole migration onto a changed backend contract (AMI-268/270): «almost every question I had
  was of the form "operation X changed — who reads it, who writes it, and where does the in-bundle mock
  implement it", and I could not route any of them through codemaster, so the whole session ran on grep»;
  wanted `operation_graph({operationId}) -> {callsites, generatedHooks, handWrittenOverride, mockHandler,
  queryKeyRoot}`, did `grep -rn` across four directories plus reading doc comments. Their closing note is the
  cost: «the repo's own doc is right that grep is silently incomplete here — which is precisely why this gap
  stung: I knew grep was the wrong tool and had no right one.»

Two independent reports, same repo, both ended in hand-written tooling.
