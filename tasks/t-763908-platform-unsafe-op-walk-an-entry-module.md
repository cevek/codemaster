---
id: t-763908
title: "`platform_unsafe` op: walk an entry module's static import closure and flag non-browser globals/APIs (Buffer/process/__dirname/require/node:*)"
status: backlog
priority: low
tags:
  - dogfood-jul
type: feat
importance: low
complexity: L
area: wish
created: '2026-07-07T20:07:08.741Z'
---
Inbox entry 6 (`code-diff/browser-playground`), 2026-07-02. De-noding a sync path for the browser: `node:` *imports* were grep-able, but the real footgun was a Node *global* — `Buffer.byteLength` — deep in the runtime path. Neither a `node:`-import grep nor a jsdom test catches it (jsdom runs under Node, so `Buffer`/`process`/`__dirname` are defined); only a live browser run surfaced `ReferenceError: Buffer is not defined`. Ask: `platform_unsafe {entry, target:'browser'}` walks the static import closure and reports references to non-browser globals/APIs (`Buffer`, `process`, `__dirname`, `require`, `node:*` re-exports, `fs`/`child_process`) with proof spans — closing the exact gap grep (imports only) and Node-hosted tests (globals silently satisfied) both miss. codemaster already resolves the import graph + symbols.
