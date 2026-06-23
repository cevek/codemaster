// Discriminating oracle for the serveMcp exit-seam (server.ts) — proves the §16 honesty hole it
// closes is REAL, not hypothetical. The hole: serveMcp wires onclose→shutdown→exit(0); if that exit
// reaches `process.exit`, a `client.close()` inside an in-process e2e test hard-exits the test FILE
// with code 0 mid-run, so `node --test` (which trusts the child's exit code) reads a FAILED subtest
// as a green vacuum-pass. A direct unit assertion ("exit is injectable") could NOT prove "a red
// subtest reads green" — only a real `node --test` child can. So this is a two-arm SUBPROCESS oracle:
//
//   • masking arm  (MASK=1) — force `process.exit` even over the injected transport (the pre-fix
//     behavior): the child's intentionally-RED subtest is masked → child exits 0.
//   • fix arm      (MASK=0) — the shipped default (injected transport ⇒ no-op exit): the same RED
//     subtest surfaces → child exits NON-zero.
//
// The oracle is the child's real exit code from `node --test`. The two arms differ ONLY in whether
// the exit-seam is forced to `process.exit`, so the differing codes pin the seam as the cause.
//
// The child is GENERATED into test/e2e/ at runtime (so node_modules / the MCP SDK resolve) with a
// pid-unique `.gen.ts` name — outside the `*.test.ts` glob, so `npm test` never collects it — and
// removed in `finally` (plus a defensive sweep of stale siblings from a prior hard-exit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD_PREFIX = 'exit-seam-child.';
const CHILD_SUFFIX = '.gen.ts';

// The generated child: wire serveMcp over an in-memory transport, run ONE intentionally-failing
// subtest, then close the client to trigger onclose→shutdown→exit. MASK=1 forces `process.exit`
// (pre-fix); MASK=0 takes the shipped transport-derived default (no-op). The `await delay` gives
// shutdown's async `dispose().finally(exit)` time to fire process.exit BEFORE the red assertion runs
// — so under MASK=1 the process is already gone (exit 0) and the failure never reports.
const CHILD_SOURCE = `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serveMcp } from ${JSON.stringify(join(here, '..', '..', 'src', 'mcp', 'server.ts'))};

const MASK = process.env.MASK === '1';
const stub = {
  sourceStale: () => false,
  dispose: async () => undefined,
  request: async (_cwd, _root, reqs) => ({
    ok: true,
    results: reqs.map((r) => ({ name: r.name, result: { ok: true, data: {} } })),
  }),
  status: async () => ({}),
};

test('intentionally RED subtest — masked iff shutdown reaches process.exit', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  // MASK arm forces process.exit even over the injected transport; fix arm omits exit → no-op default.
  await serveMcp(stub, 'test', MASK ? { transport: serverT, exit: (c) => process.exit(c) } : { transport: serverT });
  const client = new Client({ name: 'masking-child', version: '0' });
  await client.connect(clientT);
  await client.callTool({ name: 'find_definition', arguments: { q: 'X' } });
  // Closing the client closes the linked server transport → server.onclose = shutdown → exit().
  await client.close();
  // Let shutdown's async dispose().finally(exit) fire. Under MASK=1 process.exit(0) wins here and
  // the assertion below never runs; under MASK=0 the no-op exit lets the red assertion surface.
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(false, 'this subtest is intentionally red and MUST be reported as a failure');
});
`;

function sweepStaleChildren(): void {
  for (const name of readdirSync(here)) {
    if (name.startsWith(CHILD_PREFIX) && name.endsWith(CHILD_SUFFIX)) {
      rmSync(join(here, name), { force: true });
    }
  }
}

/** Run the generated child under `node --test` with the given MASK env; resolve its exit code.
 *  A hard timeout turns a hang (itself the §1 cardinal sin) into a loud failure, never a block. */
function runChild(childPath: string, mask: '0' | '1'): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // Strip NODE_TEST_CONTEXT: this parent runs under `node --test`, which sets it; an inheriting
    // child would report results to us over the V8 IPC channel instead of setting its OWN exit code
    // from failures — so the child's exit code (our oracle) would be 0 regardless. A fresh top-level
    // runner is the whole point. (MASK selects the arm.)
    const { NODE_TEST_CONTEXT: _drop, ...cleanEnv } = process.env;
    const child = spawn(process.execPath, ['--test', childPath], {
      cwd: join(here, '..', '..'),
      env: { ...cleanEnv, MASK: mask },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`child (MASK=${mask}) did not exit within timeout (hang?). stderr:\n${stderr}`),
      );
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('exit-seam: a RED subtest is MASKED (exit 0) when shutdown reaches process.exit, and SURFACES (exit≠0) under the shipped no-op default', async () => {
  sweepStaleChildren();
  const childPath = join(here, `${CHILD_PREFIX}${process.pid}${CHILD_SUFFIX}`);
  writeFileSync(childPath, CHILD_SOURCE, 'utf8');
  try {
    const masked = await runChild(childPath, '1');
    const surfaced = await runChild(childPath, '0');
    // The masking arm proves the hole is real: process.exit(0) swallows the failed subtest.
    assert.equal(
      masked,
      0,
      'masking arm: forcing process.exit hard-exits the file 0, masking the red subtest',
    );
    // The fix arm proves the seam closes it: the transport-derived no-op default lets the failure report.
    assert.notEqual(
      surfaced,
      0,
      'fix arm: the shipped no-op exit default lets the red subtest fail honestly',
    );
  } finally {
    rmSync(childPath, { force: true });
  }
});
