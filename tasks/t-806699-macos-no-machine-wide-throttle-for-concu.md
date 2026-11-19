---
id: t-806699
title: 'macOS: no machine-wide throttle for concurrent test runs (cpu-slots is Linux-only)'
status: backlog
priority: low
created_by_session: s-363919
author: mb-c5e4101d
created: '2026-11-19T08:00:48.654Z'
---
`cpu-slots` (the `test*` scripts in `package.json` run `cpu-slots-node --test`) is a no-op off Linux. With the whole-run lock (`scripts/with-test-lock.mjs`) removed under t-011900, several agents' full `npm test` runs on one macOS machine oversubscribe the CPU unthrottled; the lock's default `TEST_CONCURRENCY = cores − 4` headroom is gone too.

Options: macOS support upstream in `cpu-slots` (a different exclusive primitive — abstract unix sockets are Linux-only), or accept and narrow by hand with `TEST_CONCURRENCY`. Measure first whether mac runs actually time out under concurrent load before building anything.
