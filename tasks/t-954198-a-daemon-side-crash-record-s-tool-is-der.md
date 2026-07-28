---
id: t-954198
title: A daemon-side crash record's `tool` is derived, not known — thread the real MCP tool name through the wire envelope
status: backlog
priority: low
tags:
  - platform
type: imp
complexity: S
area: platform
created: '2026-07-28T07:26:50.025Z'
---
The MCP tool name never crosses the socket, so `daemon/daemon-server.ts` `describe()` derives `tool` for its crash breadcrumb from the wire request. The wire's `batch` field looks like the discriminator but is not: `mcp/server.ts` attaches it only when the call carries `sql`, so a plain `batch({requests:[…]})` arrives WITHOUT it and a per-op call WITH `sql` arrives with it.

Deriving from it named the wrong tool in both directions, so the derivation is now the request COUNT (>1 request can only be a batch), which is honest but leaves one case the wire cannot distinguish: a `batch` of exactly ONE request reads as a per-op call. `ops` is exact in every case, which is why triage and the correlation recipe key on `cwd` + `ops` rather than `tool`.

## Fix

Carry the invoking tool name as an optional field on the request/status envelope (`daemon/protocol.ts`); the bridge has it at hand (`mcp/server.ts` `request.params.name`). The daemon then records what was actually invoked instead of inferring it, and `tool` becomes usable as a correlation key.

The cost is a wider signature: `OrchestratorApi.request` does not currently take the tool name, so it has to reach `createRemoteOrchestrator` — which is why this was left out of the change that introduced the daemon-side breadcrumb rather than bundled into it.

Covered today by `test/e2e/daemon-usage-crash.test.ts`, which pins both the single-op and multi-request derivations; the single-request-batch case is the one that stays approximate.
