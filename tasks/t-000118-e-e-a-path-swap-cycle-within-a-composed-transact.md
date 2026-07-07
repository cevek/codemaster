---
id: t-000118
title: E-e — a path swap/cycle within a composed transaction
status: backlog
priority: low
type: feat
complexity: M
area: transaction
created: '2026-07-08T00:01:57.000Z'
---
**E-e — a path swap/cycle within a composed transaction** (`a→b` while `c→a`) hits the clobber
guard → honest refusal (never corruption); a legitimate swap needs temp-file ordering.
`feat`·`low`·`cx:M`
