---
id: t-235927
title: 'CLI entry: enable module compile cache before the module graph loads'
status: backlog
priority: medium
author: mb-629b22fe
created: '2026-11-17T10:37:45.306Z'
---
`src/bin.ts` (composition root, statically imports the whole graph) is the entry agents run for every one-shot `node src/bin.ts op …`; each call re-strips `src/*.ts` and recompiles `typescript.js`. `module.enableCompileCache()` only affects modules loaded after the call, and ESM links every static import before evaluating any, so calling it inside `bin.ts` (or from a first side-effect import) is too late.

Shape: a thin entry that calls `module.enableCompileCache()` (it honors `NODE_COMPILE_CACHE` / `NODE_DISABLE_COMPILE_CACHE`, default dir `os.tmpdir()/node-compile-cache`) and then dynamic-imports the composition root. Keep the `src/bin.ts` path (79 references: package `bin`, docs, `render-status.ts` hint, spawns), so the composition root body moves to a new module; `src/README.md` and the comments naming `bin.ts` as composition root follow it. The spawned daemon/engine children inherit the cache via env only when it is set; whether to export it for them is open.

Measure: CPU of a one-shot `op` cold vs warm cache.
