// The wiring half of the child heap ceiling (t-811950, §9): the number `heap-ceiling.ts` resolves is
// the number the fork actually receives. `heap-ceiling.test.ts` proves the arithmetic; this proves
// nobody resolves it and then forks with something else — a silent drop here is invisible in every
// arithmetic test and is exactly the shape of the defect being fixed (a ceiling that "exists" and
// raises nothing). The real fork's `execArgv` path is covered by the process-isolation e2e; here the
// fork is faked so the assertion is on the ARGUMENT, deterministically and with no subprocess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import process from 'node:process';
import { makeProcessHostFactory } from '../../src/daemon/process-host-factory.ts';
import { createProcessHost } from '../../src/daemon/process-host.ts';
import { boxMemoryBytes, resolveChildHeapMB } from '../../src/daemon/heap-ceiling.ts';
import { manualClock } from '../helpers/project.ts';
import type { EngineChildHandle, ForkEngineOpts } from '../../src/daemon/fork-engine.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { CodemasterConfig } from '../../src/config/config.ts';
import type { RepoId } from '../../src/core/brands.ts';

const GB = 1024 * 1024 * 1024;

/** A fake child that records the fork opts and completes the ready handshake on the next tick (the
 *  host registers its message callback after `spawn` returns, so a synchronous `ready` would be
 *  missed and the spawn would sit on its 60 s startup deadline). */
function capturingFork(seen: ForkEngineOpts[]): (o: ForkEngineOpts) => EngineChildHandle {
  return (o) => {
    seen.push(o);
    let onMessage: ((raw: JsonValue) => void) | undefined;
    let onExit: ((code: number | null, signal: string | null) => void) | undefined;
    setTimeout(() => onMessage?.({ kind: 'ready' }), 0);
    return {
      pid: 1234,
      // A real child exits on a `dispose` frame (and on a signal); without either the host's dispose
      // would sit out its 5 s grace and the test would hang on a pending promise instead of
      // asserting anything.
      send: (frame) => {
        if ((frame as { kind?: string }).kind === 'dispose') setTimeout(() => onExit?.(0, null), 0);
      },
      kill: () => onExit?.(0, null),
      onMessage: (cb) => (onMessage = cb),
      onExit: (cb) => (onExit = cb),
    };
  };
}

async function forkedWith(
  config: CodemasterConfig,
  totalMemBytes: number,
): Promise<ForkEngineOpts> {
  const seen: ForkEngineOpts[] = [];
  const factory = makeProcessHostFactory({
    binPath: '/nonexistent/bin.ts',
    version: 'test',
    requestDeadlineMs: 1_000,
    sockDir: undefined,
    forkChild: capturingFork(seen),
    totalMemBytes,
  });
  const spawned = await factory({
    repoId: '/repo' as RepoId,
    root: '/repo',
    config,
    stateDir: '/state',
    onExit: () => undefined,
  });
  assert.ok(spawned.ok, spawned.ok ? '' : spawned.message);
  if (spawned.ok) await spawned.host.dispose();
  const opts = seen[0];
  assert.ok(opts !== undefined, 'the factory forked exactly one child');
  return opts;
}

test('with no config the fork receives the BOX-derived ceiling, not a fixed 4096', async () => {
  const opts = await forkedWith({}, 32 * GB);
  assert.equal(opts.maxOldSpaceMB, 8192);
  // The regression this guards: 4096 equals Node's own default limit on such a box, so forking with
  // it raised nothing at all and the escalated child died ~1.1 GB below its measured need.
  assert.notEqual(opts.maxOldSpaceMB, 4096);
});

test('a config ceiling reaches the fork verbatim — the box does not override the user', async () => {
  const opts = await forkedWith({ daemon: { maxOldSpaceMB: 2048 } }, 32 * GB);
  assert.equal(opts.maxOldSpaceMB, 2048);
});

test('a small box still forks with the historical floor (no regression)', async () => {
  const opts = await forkedWith({}, 4 * GB);
  assert.equal(opts.maxOldSpaceMB, 4096);
});

test('with no seam the factory reads THIS box — not a constant, not free memory', async () => {
  // The seam above proves the plumbing; this proves production takes the real reading. Without it the
  // whole box→flag path would be untested (every e2e injects its own `maxOldSpaceMB`), so a factory
  // that ignored `os.totalmem()` and shipped a constant would pass every other test here.
  const seen: ForkEngineOpts[] = [];
  const factory = makeProcessHostFactory({
    binPath: '/nonexistent/bin.ts',
    version: 'test',
    requestDeadlineMs: 1_000,
    sockDir: undefined,
    forkChild: capturingFork(seen),
  });
  const spawned = await factory({
    repoId: '/repo' as RepoId,
    root: '/repo',
    config: {},
    stateDir: '/state',
    onExit: () => undefined,
  });
  assert.ok(spawned.ok, spawned.ok ? '' : spawned.message);
  if (spawned.ok) await spawned.host.dispose();
  const expected = resolveChildHeapMB(
    {},
    boxMemoryBytes(os.totalmem(), process.constrainedMemory?.()),
  ).maxOldSpaceMB;
  assert.equal(seen[0]?.maxOldSpaceMB, expected);
  // A whole-MB flag on THIS machine too, whatever its `totalmem` reading looks like: a fractional
  // value makes node exit 9, which for an auto escalation degrades silently to in-process.
  assert.ok(Number.isInteger(expected), `${String(expected)} is not a whole MB`);
});

test('an OOM failure names the ceiling that was exhausted and how to move it', async () => {
  // `code=134` alone cannot distinguish "this repo needs more than the box gives one child" from
  // "more than the number someone configured" — and only the second has a remedy the caller can act
  // on. Without the carry the message states neither.
  const clock = manualClock();
  let onExit: ((code: number | null, signal: string | null) => void) | undefined;
  let onMessage: ((raw: JsonValue) => void) | undefined;
  const p = createProcessHost({
    repoId: '/repo' as RepoId,
    clock,
    spawn: () => ({
      pid: 99,
      send: () => undefined,
      kill: () => undefined,
      onMessage: (cb) => (onMessage = cb),
      onExit: (cb) => (onExit = cb),
    }),
    startupDeadlineMs: 1_000,
    requestDeadlineMs: 5_000,
    disposeDeadlineMs: 100,
    onExit: () => undefined,
    heapCeiling: 'heap ceiling 8192 MB (the default cap — raise it with daemon.maxOldSpaceMB)',
  });
  onMessage?.({ kind: 'ready' });
  const spawned = await p;
  assert.ok(spawned.ok, spawned.ok ? '' : spawned.message);
  if (!spawned.ok) return;
  const inflight = spawned.host.request([{ name: 'find_usages', args: { name: 'X' } as never }]);
  onExit?.(134, null); // V8 heap OOM signature
  const r0 = (await inflight)[0];
  assert.ok(r0 !== undefined && 'result' in r0 && r0.result.ok === false, 'an OOM fails honestly');
  if (r0 === undefined || !('result' in r0) || r0.result.ok !== false) return;
  assert.equal(r0.result.failure.tool, 'oom');
  assert.match(r0.result.failure.message, /heap ceiling 8192 MB/);
  assert.match(r0.result.failure.message, /daemon\.maxOldSpaceMB/);
});
