// Deterministic unit tests for the `process`-mode host's never-hang / crash-honesty logic
// (ARCHITECTURE.md §1/§2/§9). No real subprocess: a FAKE `EngineChildHandle` + the manual `Clock`
// drive every path — startup handshake, reply matching, per-request deadline → SIGKILL → honest
// timeout, crash/OOM → honest ToolFailure + slot eviction, no double-settle. The real-subprocess
// teardown/parity paths are the e2e smoke (process-isolation.test.ts); those can't be faked, these
// can't flake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessHost, KILL_BELT_MS } from '../../src/daemon/process-host.ts';
import type { EngineChildHandle } from '../../src/daemon/fork-engine.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { RepoId } from '../../src/core/brands.ts';
import { manualClock } from '../helpers/project.ts';
import { cheapCallsFor, navigationFor } from '../../src/ops/guard/navigate.ts';

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

test('deadline BELT: a SIGKILLed child that NEVER emits exit is still force-settled (never-hang)', async () => {
  const fc = fakeChild();
  const clock = manualClock();
  let exited = 0;
  const host = await armedHost(fc, clock, () => (exited += 1), { requestDeadlineMs: 5_000 });
  const reqP = host.request([{ name: 'find_usages', args: {} as never }]);
  clock.advance(5_000); // deadline → SIGKILL
  assert.deepEqual(fc.kills, ['SIGKILL']);
  // The child is un-reapable: no `exit` EVER fires. Without the belt this would hang forever.
  clock.advance(KILL_BELT_MS);
  const res = await reqP; // must resolve on the belt alone (no fc.exit call)
  const r0 = res[0];
  assert.ok(r0 !== undefined && 'result' in r0 && !r0.result.ok);
  assert.equal(r0.result.ok === false && r0.result.failure.tool, 'timeout');
  assert.equal(exited, 1);
});

test('dispose BELT: dispose resolves even if the child never exits (no shutdown hang)', async () => {
  const fc = fakeChild();
  const clock = manualClock();
  const host = await armedHost(fc, clock, () => undefined); // disposeDeadlineMs = 100 in armedHost
  const dp = host.dispose();
  clock.advance(100); // dispose grace elapses → SIGKILL
  assert.deepEqual(fc.kills, ['SIGKILL'], 'a child that ignores dispose is SIGKILLed');
  clock.advance(KILL_BELT_MS); // child still never exits — the belt must resolve dispose
  await dp; // resolves, or this test hangs (the bug)
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

// t-615758. The three ways a child dies are NOT one claim. `tool` and the verdict clause already
// discriminate them — only an exhausted heap proves the repo cannot answer — and the envelope's
// machine-readable claim has to say the same thing, or a consumer switching on it is told an
// impossibility we never established. The oracle is the reason itself: each is driven through the
// real host and the claim read off the envelope, so a single unconditional value fails two arms.
test('each way the child dies gets the claim it actually supports', async () => {
  const claimAfter = async (
    die: (fc: FakeChild, clock: ReturnType<typeof manualClock>) => void,
  ) => {
    const fc = fakeChild();
    const clock = manualClock();
    const host = await armedHost(fc, clock, () => undefined, { requestDeadlineMs: 10 });
    const reqP = host.request([{ name: 'find_usages', args: { name: 'Button' } as never }]);
    die(fc, clock);
    const [r] = await reqP;
    assert.ok(r !== undefined && 'result' in r && r.result.ok === false);
    return r.result.failure.outOfReach;
  };

  // An exhausted heap: a retry does the same thing again, so no program build is within reach.
  assert.equal(await claimAfter((fc) => fc.exit(134, null)), 'any-program-build');
  // Killed on the deadline, and a bare non-zero exit: both say what happened to THIS call and
  // nothing about the next one. Claiming impossibility off either would be an unearned verdict.
  assert.equal(
    await claimAfter((fc, clock) => {
      clock.advance(10);
      fc.exit(null, 'SIGKILL');
    }),
    'unproven-program-build',
  );
  assert.equal(await claimAfter((fc) => fc.exit(1, null)), 'unproven-program-build');
});

// …and the caution does NOT vary with the claim: `unproven` is treated exactly as conservatively
// as the proven case, because a call we cannot vouch for is as bad to name as one we know is gone.
test('an unproven claim still names no program-building call', () => {
  const args = { name: 'Button', prop: 'size', file: 'src/Button.tsx' };
  for (const op of ['trace_prop_through_tree', 'trace_type_widening', 'find_definition']) {
    for (const c of cheapCallsFor(op, args, 'unproven-program-build').calls) {
      assert.notEqual(c.buildsProgram, true, `${op} offers a program build on an unproven claim`);
    }
  }
});

// t-959904. This is the message an agent on an oversized repo actually reads: such a repo is
// auto-escalated at spawn, so the in-process fan-out guard never fires there. Three properties, none
// of which the guards' own tests can pin, because this path composes them differently.
test('a died-engine failure redirects per request, verdict-scoped, redirect before cause', async () => {
  const fc = fakeChild();
  const host = await armedHost(fc, manualClock(), () => undefined);
  const reqP = host.request([
    { name: 'find_usages', args: { name: 'Button' } as never },
    { name: 'impact', args: { name: 'Widget' } as never },
  ]);
  fc.exit(134, null); // OOM signature
  const [a, b] = await reqP;
  const msg = (r: typeof a) =>
    r !== undefined && 'result' in r && r.result.ok === false ? r.result.failure.message : '';

  // Per-request, not one shared string: a batch's requests ask different questions.
  assert.match(msg(a), /"Button"/, 'the first request keeps its own subject');
  assert.match(msg(b), /"Widget"/, 'the second is not given the first request’s redirect');
  assert.match(msg(a), /find_usages cannot complete/);
  assert.match(msg(b), /impact cannot complete/);

  // Redirect BEFORE cause — inverted vs the guards on purpose. Not a survival argument (the message
  // renders into the reserved envelope `head`, and a batch is cut at whole-section boundaries): §12
  // verdict-first. The op is already dead, so the cause restates what the agent knows, while the
  // redirect is the only part it can act on.
  for (const m of [msg(a), msg(b)]) {
    const redirect = Math.max(m.indexOf('RUN INSTEAD'), m.indexOf('NO cheaper in-tool path'));
    assert.ok(redirect > 0 && m.indexOf('Cause:') > redirect, `redirect must precede cause: ${m}`);
  }
});

// Only an OOM proves the call cannot succeed here. A deadline overrun does not, and saying so would
// be an unearned claim of impossibility — the honesty rule applied to our own failure text.
test('a timeout says the call did not complete, never that the repo cannot answer it', async () => {
  const fc = fakeChild();
  const clock = manualClock();
  const host = await armedHost(fc, clock, () => undefined, { requestDeadlineMs: 10 });
  const reqP = host.request([{ name: 'find_usages', args: { name: 'Button' } as never }]);
  clock.advance(10);
  fc.exit(null, 'SIGKILL');
  const [r] = await reqP;
  const msg =
    r !== undefined && 'result' in r && r.result.ok === false ? r.result.failure.message : '';
  assert.match(msg, /find_usages did not complete/);
  assert.doesNotMatch(
    msg,
    /cannot complete on this repo/,
    'a timeout is not proof of impossibility',
  );
  // t-615758: the failure STATES what it leaves out of reach rather than leaving each consumer to
  // re-infer it — and it states it with the SAME discrimination the verdict above uses. A killed
  // child proves nothing about program-build capability, so the claim is `unproven`, not the
  // proven impossibility. The message is pinned byte-exact around the shared redirect, so a drift
  // in the verdict clause or the cause clause is a diff rather than something the loose matches
  // above would still pass.
  assert.equal(
    r !== undefined && 'result' in r && r.result.ok === false
      ? r.result.failure.outOfReach
      : undefined,
    'unproven-program-build',
  );
  const redirect = navigationFor('find_usages', { name: 'Button' }, 'unproven-program-build');
  assert.equal(
    msg,
    `find_usages did not complete. ${redirect} Cause: isolated engine did not reply in 10ms — killed it.`,
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
