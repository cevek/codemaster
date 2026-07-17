// Deterministic unit tests for the `process`-mode host's never-hang / crash-honesty logic
// (ARCHITECTURE.md §1/§2/§9). No real subprocess: a FAKE `EngineChildHandle` + the manual `Clock`
// drive every path — startup handshake, reply matching, per-request deadline → SIGKILL → honest
// timeout, crash/OOM → honest ToolFailure + slot eviction, no double-settle. The real-subprocess
// teardown/parity paths are the e2e smoke (process-isolation.test.ts); those can't be faked, these
// can't flake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessHost } from '../../src/daemon/process-host.ts';
import type { EngineChildHandle } from '../../src/daemon/fork-engine.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { RepoId } from '../../src/core/brands.ts';
import { manualClock } from '../helpers/project.ts';

interface FakeChild {
  handle: EngineChildHandle;
  sent: JsonValue[];
  kills: string[];
  emit(frame: unknown): void;
  exit(code: number | null, signal: string | null): void;
}

function fakeChild(pid = 4242): FakeChild {
  let onMessage: ((raw: JsonValue) => void) | undefined;
  let onExit: ((code: number | null, signal: string | null) => void) | undefined;
  const sent: JsonValue[] = [];
  const kills: string[] = [];
  return {
    handle: {
      pid,
      send: (frame) => sent.push(frame),
      kill: (signal) => kills.push(signal),
      onMessage: (cb) => (onMessage = cb),
      onExit: (cb) => (onExit = cb),
    },
    sent,
    kills,
    emit: (frame) => onMessage?.(frame as JsonValue),
    exit: (code, signal) => onExit?.(code, signal),
  };
}

const REPO = 'r' as RepoId;
const lastId = (fc: FakeChild): number => {
  const frame = fc.sent[fc.sent.length - 1] as { id?: number } | undefined;
  return frame?.id ?? -1;
};

/** Spawn a host and complete the ready handshake — the common prologue for the request tests. */
async function armedHost(
  fc: FakeChild,
  clock: ReturnType<typeof manualClock>,
  onExit: () => void,
  overrides?: { requestDeadlineMs?: number },
) {
  const p = createProcessHost({
    repoId: REPO,
    clock,
    spawn: () => fc.handle,
    startupDeadlineMs: 1_000,
    requestDeadlineMs: overrides?.requestDeadlineMs ?? 5_000,
    disposeDeadlineMs: 100,
    onExit,
  });
  fc.emit({ kind: 'ready' });
  const spawned = await p;
  assert.ok(spawned.ok, 'ready handshake resolves the spawn');
  return spawned.ok ? spawned.host : assert.fail('unreachable');
}

test('startup: fatal frame fails the spawn honestly', async () => {
  const fc = fakeChild();
  const p = createProcessHost({
    repoId: REPO,
    clock: manualClock(),
    spawn: () => fc.handle,
    startupDeadlineMs: 1_000,
    requestDeadlineMs: 5_000,
    disposeDeadlineMs: 100,
    onExit: () => undefined,
  });
  fc.emit({ kind: 'fatal', message: 'plugin init blew up' });
  const spawned = await p;
  assert.equal(spawned.ok, false);
  assert.match(spawned.ok ? '' : spawned.message, /plugin init blew up/);
});

test('startup: no ready before the deadline → honest spawn failure + SIGKILL', async () => {
  const fc = fakeChild();
  const clock = manualClock();
  const p = createProcessHost({
    repoId: REPO,
    clock,
    spawn: () => fc.handle,
    startupDeadlineMs: 1_000,
    requestDeadlineMs: 5_000,
    disposeDeadlineMs: 100,
    onExit: () => undefined,
  });
  clock.advance(1_000);
  const spawned = await p;
  assert.equal(spawned.ok, false);
  assert.deepEqual(fc.kills, ['SIGKILL'], 'a non-starting child is killed, not left running');
});

test('request: a matching reply resolves with the engine results', async () => {
  const fc = fakeChild();
  const host = await armedHost(fc, manualClock(), () => undefined);
  const reqP = host.request([{ name: 'find_definition', args: {} as never }]);
  fc.emit({
    id: lastId(fc),
    kind: 'request',
    results: [{ name: 'find_definition', result: { ok: true, data: { hit: 1 } } }],
  });
  const res = await reqP;
  assert.deepEqual(res, [{ name: 'find_definition', result: { ok: true, data: { hit: 1 } } }]);
});

test('produceSql: reply carries results + freshness through', async () => {
  const fc = fakeChild();
  const host = await armedHost(fc, manualClock(), () => undefined);
  const p = host.produceSql([{ name: 'find_usages', args: {} as never }]);
  fc.emit({
    id: lastId(fc),
    kind: 'produceSql',
    results: [{ name: 'find_usages', result: { ok: true, data: [] } }],
    freshness: { reindexed: 2 },
  });
  const out = await p;
  assert.deepEqual(out.freshness, { reindexed: 2 });
  assert.equal(out.results.length, 1);
});

test('deadline: an unanswered request SIGKILLs the child and settles as an honest timeout', async () => {
  const fc = fakeChild();
  const clock = manualClock();
  let exited = 0;
  const host = await armedHost(fc, clock, () => (exited += 1), { requestDeadlineMs: 5_000 });
  const reqP = host.request([{ name: 'find_usages', args: {} as never }]);
  clock.advance(5_000); // trips the deadline → kill
  assert.deepEqual(fc.kills, ['SIGKILL'], 'a wedged child is killed on deadline (§19)');
  fc.exit(null, 'SIGKILL'); // the kill lands — markDead settles the pending request
  const res = await reqP;
  const r0 = res[0];
  assert.ok(r0 !== undefined && 'result' in r0 && !r0.result.ok);
  assert.equal(r0.result.ok === false && r0.result.failure.tool, 'timeout');
  assert.equal(exited, 1, 'onExit fires once so the orchestrator evicts + respawns');
});

test('crash: child exit while pending → honest engine-process failure + onExit', async () => {
  const fc = fakeChild();
  let exited = 0;
  const host = await armedHost(fc, manualClock(), () => (exited += 1));
  const reqP = host.request([{ name: 'expand_type', args: {} as never }]);
  fc.exit(1, null); // crashed, no deadline tripped
  const res = await reqP;
  const r0 = res[0];
  assert.ok(r0 !== undefined && 'result' in r0 && !r0.result.ok);
  assert.equal(r0.result.ok === false && r0.result.failure.tool, 'engine-process');
  assert.equal(exited, 1);
});

test('oom hint: a SIGABRT/134 exit is labelled oom, not a bare crash', async () => {
  const fc = fakeChild();
  const host = await armedHost(fc, manualClock(), () => undefined);
  const reqP = host.request([{ name: 'find_usages', args: {} as never }]);
  fc.exit(134, null);
  const res = await reqP;
  const r0 = res[0];
  assert.equal(
    r0 !== undefined && 'result' in r0 && r0.result.ok === false && r0.result.failure.tool,
    'oom',
  );
});

test('no double-settle: a late reply after a crash is ignored', async () => {
  const fc = fakeChild();
  const host = await armedHost(fc, manualClock(), () => undefined);
  const reqP = host.request([{ name: 'find_usages', args: {} as never }]);
  const id = lastId(fc);
  fc.exit(1, null); // settles as crash
  const res = await reqP;
  // A stray late reply for the same id must not re-settle or throw.
  fc.emit({
    id,
    kind: 'request',
    results: [{ name: 'find_usages', result: { ok: true, data: [] } }],
  });
  const r0 = res[0];
  assert.ok(
    r0 !== undefined && 'result' in r0 && !r0.result.ok,
    'the crash result stands; the late reply is dropped',
  );
});

test('request after death: settles immediately as a failure (no hang)', async () => {
  const fc = fakeChild();
  const host = await armedHost(fc, manualClock(), () => undefined);
  fc.exit(1, null);
  const res = await host.request([{ name: 'find_usages', args: {} as never }]);
  const r0 = res[0];
  assert.ok(r0 !== undefined && 'result' in r0 && !r0.result.ok);
});
