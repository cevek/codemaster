---
id: t-000014
title: schema endpoint card reads `certain` while its body/response type is unresolvable
status: backlog
priority: medium
type: bug
complexity: S
area: bug-sweep
created: '2026-07-08T00:00:13.000Z'
---
**schema endpoint card reads `certain` while its body/response type is unresolvable** —
`src/plugins/schema/parse.ts:141-160,221`. `buildCard` derives card `confidence` from `notes`,
but `notes` is populated only for `query`/`response` enumeration failure; a `requestBody`/
response content that falls to `contentRef`'s `partial` catch-all (`:221`) never demotes the
card. In `list_endpoints` sql/table mode (`list-endpoints.ts:31-40`) the slot's own `partial`
is dropped, so the row reads a clean `certain` (§3.4 completeness lie). Trigger needs
non-standard generator output (union / bare-alias content). Fix: demote the card to `partial`
when `body`/`resp` came back `partial`. `bug`·`med`·`cx:S`
