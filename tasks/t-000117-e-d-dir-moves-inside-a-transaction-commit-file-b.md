---
id: t-000117
title: E-d — dir moves inside a transaction commit file-by-file
status: backlog
priority: low
type: bug
complexity: M
area: transaction
created: '2026-07-08T00:01:56.000Z'
---
**E-d — dir moves inside a transaction commit file-by-file** (per-file `git mv`) so an emptied
source dir may linger. A single `move_file` of a folder is unaffected. `bug`·`low`·`cx:M`
