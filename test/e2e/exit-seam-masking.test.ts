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
// The child is the committed `exit-seam-masking.child.ts`: nothing is generated, so concurrent runs of
// this file from one checkout share nothing to delete under each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CHILD = join(here, 'exit-seam-masking.child.ts');
/** The child's red assertion message: its presence tells "the red subtest ran and was reported" from
 *  any other non-zero exit (a child that failed to load, a crash). */
const RED_MESSAGE = 'this subtest is intentionally red and MUST be reported as a failure';

/** Run the child under `node --test` with the given MASK env; resolve its exit code and output.
 *  A hard timeout turns a hang (itself the §1 cardinal sin) into a loud failure, never a block. */
function runChild(mask: '0' | '1'): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    // Strip NODE_TEST_CONTEXT: this parent runs under `node --test`, which sets it; an inheriting
    // child would report results to us over the V8 IPC channel instead of setting its OWN exit code
    // from failures — so the child's exit code (our oracle) would be 0 regardless. A fresh top-level
    // runner is the whole point. (MASK selects the arm.)
    const { NODE_TEST_CONTEXT: _drop, ...cleanEnv } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', CHILD], {
      cwd: join(here, '..', '..'),
      env: { ...cleanEnv, MASK: mask },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (out += c));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`child (MASK=${mask}) did not exit within timeout (hang?). output:\n${out}`),
      );
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('exit-seam: a RED subtest is MASKED (exit 0) when shutdown reaches process.exit, and SURFACES (exit≠0) under the shipped no-op default', async () => {
  const masked = await runChild('1');
  const surfaced = await runChild('0');
  // The masking arm proves the hole is real: process.exit(0) swallows the failed subtest.
  assert.equal(
    masked.code,
    0,
    `masking arm: forcing process.exit hard-exits the file 0, masking the red subtest\n${masked.out}`,
  );
  // The fix arm proves the seam closes it: the transport-derived no-op default lets the failure
  // report — exit 1 from THAT red assertion, not from a child that never reached it.
  assert.equal(
    surfaced.code,
    1,
    `fix arm: the shipped no-op exit default lets the red subtest fail honestly\n${surfaced.out}`,
  );
  assert.ok(
    surfaced.out.includes(RED_MESSAGE),
    `fix arm: red assertion not reported\n${surfaced.out}`,
  );
});
