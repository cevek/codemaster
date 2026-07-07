---
id: t-000001
title: CODEMASTER_SOCK_DIR` is read unconditionally in prod (`bin.ts:141/165/195`)
status: backlog
priority: low
type: bug
complexity: S
area: platform
created: '2026-07-08T00:00:00.000Z'
---
**`CODEMASTER_SOCK_DIR` is read unconditionally in prod (`bin.ts:141/165/195`)** — if a user
exports it in a normal shell, a management verb honours it but the stripped-env bridge does
NOT → re-opens the exact split the fix closed. Severity low (needs a user to set an internal
test-seam var, undocumented for users). Fix idea: bridge ignores it, or warn on set; at
minimum document it as test-only. `bug`·`low`·`cx:S`
