---
id: t-000003
title: key-template separator is a space (`username version`)
status: backlog
priority: low
type: bug
complexity: S
area: platform
relates:
  - t-000002
  - t-000004
surface:
  - daemon
  - support
audience: internal
evidence: unverified
created: '2026-07-08T00:00:02.000Z'
---
**key-template separator is a space (`username version`)** — admits a theoretical
username/version collision (`"a b"+"c"` vs `"a"+"b c"`); pre-existing (main was identical),
practically impossible (POSIX usernames + semver carry no spaces). Use an unambiguous
delimiter if ever touched. `bug`·`low`·`cx:S`
