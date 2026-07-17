// Unit coverage for the wedged-daemon-recovery pidfile primitives (t-000051). Oracles: the real
// filesystem (write → read round-trip; corrupt/absent → no usable hint) and a real spawned process
// for the signal primitives (kill it, await its `exit`, assert liveness flips) — no fake clock, no
// sleep. These are the daemon-agnostic building blocks; the kill orchestration is tested separately
// once it lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  writePidfile,
  removePidfile,
  pidfilePathFor,
  type PidfileRecord,
} from '../../src/support/pidfile/write.ts';
import { readPidfile } from '../../src/support/pidfile/read.ts';
import { isProcessAlive, sendSignal } from '../../src/support/pidfile/liveness.ts';

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-pidfile-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sampleRecord = (socket: string): PidfileRecord => ({
  pid: 4242,
  socket,
  version: 'test',
  startedAt: 1_700_000_000_000,
});

test('pidfilePathFor: <socket>.pid — single source of truth for the location', () => {
  assert.equal(pidfilePathFor('/run/cm-abc.sock'), '/run/cm-abc.sock.pid');
});

test('write → read round-trips the record', () => {
  withDir((dir) => {
    const p = pidfilePathFor(path.join(dir, 'cm.sock'));
    const rec = sampleRecord(path.join(dir, 'cm.sock'));
    const w = writePidfile(p, rec);
    assert.ok(w.ok, 'write ok');
    assert.deepEqual(readPidfile(p), rec);
  });
});

test('write creates missing parent dirs (atomic temp-then-rename)', () => {
  withDir((dir) => {
    const p = pidfilePathFor(path.join(dir, 'nested', 'deeper', 'cm.sock'));
    const w = writePidfile(p, sampleRecord('s'));
    assert.ok(w.ok, 'write ok into a nonexistent dir tree');
    assert.ok(existsSync(p));
  });
});

test('read of an absent file → undefined (no usable hint, not an error)', () => {
  withDir((dir) => {
    assert.equal(readPidfile(pidfilePathFor(path.join(dir, 'cm.sock'))), undefined);
  });
});

test('read of a corrupt (non-JSON) file → undefined', () => {
  withDir((dir) => {
    const p = pidfilePathFor(path.join(dir, 'cm.sock'));
    writeFileSync(p, 'not json {{{', 'utf8');
    assert.equal(readPidfile(p), undefined);
  });
});

test('read of a schema-invalid record → undefined (missing pid / wrong type / negative)', () => {
  withDir((dir) => {
    const p = pidfilePathFor(path.join(dir, 'cm.sock'));
    for (const bad of [
      JSON.stringify({ socket: 's', version: 'v', startedAt: 1 }), // no pid
      JSON.stringify({ pid: 'x', socket: 's', version: 'v', startedAt: 1 }), // pid not a number
      JSON.stringify({ pid: -1, socket: 's', version: 'v', startedAt: 1 }), // pid not positive
      JSON.stringify({ pid: 1, socket: 's', version: 'v', startedAt: 1, extra: true }), // strict
    ]) {
      writeFileSync(p, bad, 'utf8');
      assert.equal(readPidfile(p), undefined, `rejected: ${bad}`);
    }
  });
});

test('removePidfile deletes it; a second remove on an absent file is a no-op (never throws)', () => {
  withDir((dir) => {
    const p = pidfilePathFor(path.join(dir, 'cm.sock'));
    assert.ok(writePidfile(p, sampleRecord('s')).ok);
    removePidfile(p);
    assert.equal(readPidfile(p), undefined);
    assert.doesNotThrow(() => removePidfile(p));
  });
});

test('liveness: a live process reads alive; after SIGKILL it reads gone and re-signal is noProcess', async () => {
  // A real, self-contained sleeper — deterministic teardown via its `exit` event, no polling.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore' });
  const pid = child.pid;
  assert.ok(pid !== undefined, 'child spawned with a pid');

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    assert.equal(isProcessAlive(pid), true, 'freshly spawned → alive');
    assert.equal(isProcessAlive(process.pid), true, 'this test process → alive');
    assert.equal(sendSignal(pid, 'SIGKILL'), 'sent', 'SIGKILL delivered to a live pid');
    await exited;
    assert.equal(isProcessAlive(pid), false, 'after exit → gone');
    assert.equal(sendSignal(pid, 'SIGTERM'), 'noProcess', 'signalling a gone pid → noProcess');
  } finally {
    if (isProcessAlive(pid)) child.kill('SIGKILL');
  }
});
