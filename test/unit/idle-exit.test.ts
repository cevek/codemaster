// Idle self-exit (spec-daemon-singleton Stage 1). Two oracle layers, both deterministic via an
// injected manual Clock — no sleep (§16):
//   1. createIdleExit — the gating LOGIC in isolation (in-flight never reaps, re-arm, no double-fire).
//   2. serveMcp through a real InMemoryTransport + a stub orchestrator — the WIRING (enter before the
//      try, leave in `finally` on EVERY path, including a throwing request; arm after connect). The
//      wiring is honesty-critical: a stranded in-flight count would block exit forever (the orphan
//      persists); a missing enter would reap a live call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createIdleExit } from '../../src/common/async/idle-exit.ts';
import { serveMcp } from '../../src/mcp/server.ts';
import type { Orchestrator } from '../../src/daemon/orchestrator.ts';
import type { Clock } from '../../src/common/async/clock.ts';

// serveMcp registers process-level SIGTERM/SIGINT/stdin listeners per call; several tests would
// trip Node's default 10-listener warning otherwise.
process.setMaxListeners(50);

function manualClock(): Clock & { advance(ms: number): void } {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule(ms, fn) {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        const i = timers.indexOf(timer);
        if (i !== -1) timers.splice(i, 1);
      };
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at)) {
        if (t.at <= now) {
          const i = timers.indexOf(t);
          if (i !== -1) timers.splice(i, 1);
          t.fn();
        }
      }
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

// ── 1. createIdleExit — the gating logic ────────────────────────────────────────

test('idle-exit: fires after TTL with no request (missed EOF)', () => {
  const clock = manualClock();
  let fired = 0;
  const idle = createIdleExit({ clock, idleMs: 1000, onIdle: () => (fired += 1) });
  idle.start();
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
});

test('idle-exit: never fires while a request is in flight, then fires once it completes', () => {
  const clock = manualClock();
  let fired = 0;
  const idle = createIdleExit({ clock, idleMs: 1000, onIdle: () => (fired += 1) });
  idle.start();
  idle.enter(); // request entered before the deadline
  clock.advance(5000); // well past TTL — must NOT reap a live call
  assert.equal(fired, 0);
  idle.leave(); // request done → deadline re-armed
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
});

test('idle-exit: overlapping requests hold the deadline until the last leaves', () => {
  const clock = manualClock();
  let fired = 0;
  const idle = createIdleExit({ clock, idleMs: 1000, onIdle: () => (fired += 1) });
  idle.enter();
  idle.enter();
  idle.leave(); // one still in flight
  clock.advance(5000);
  assert.equal(fired, 0);
  idle.leave(); // last one out → arm
  clock.advance(1000);
  assert.equal(fired, 1);
});

test('idle-exit: stop() cancels a pending deadline', () => {
  const clock = manualClock();
  let fired = 0;
  const idle = createIdleExit({ clock, idleMs: 1000, onIdle: () => (fired += 1) });
  idle.start();
  idle.stop();
  clock.advance(5000);
  assert.equal(fired, 0);
});

test('idle-exit: fires at most once', () => {
  const clock = manualClock();
  let fired = 0;
  const idle = createIdleExit({ clock, idleMs: 1000, onIdle: () => (fired += 1) });
  idle.start();
  clock.advance(2000);
  idle.leave(); // a stray leave after firing must not re-arm
  clock.advance(2000);
  assert.equal(fired, 1);
});

// ── 2. serveMcp — the wiring, through a real transport ───────────────────────────

function stubOrchestrator(request: Orchestrator['request']): Orchestrator {
  return {
    sourceStale: () => false,
    dispose: async () => undefined,
    request,
    status: async () => ({}) as never,
  } as unknown as Orchestrator;
}

/** Drive serveMcp over an in-memory transport pair. Returns the wired clock, the recorded exit
 *  codes, and an optional connected client. */
async function wire(
  request: Orchestrator['request'],
  withClient = false,
): Promise<{
  clock: Clock & { advance(ms: number): void };
  exits: number[];
  client?: Client;
}> {
  const clock = manualClock();
  const exits: number[] = [];
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(stubOrchestrator(request), 'test', {
    idle: { clock, idleMs: 1000, exit: (code) => exits.push(code) },
    transport: serverT,
  });
  if (!withClient) return { clock, exits };
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientT);
  return { clock, exits, client };
}

test('serveMcp: idle self-exit fires even when stdin-EOF never arrives', async () => {
  const { clock, exits } = await wire(async () => ({ ok: true, results: [] }));
  clock.advance(1001);
  await flush();
  assert.deepEqual(exits, [0]);
});

test('serveMcp: an in-flight request blocks idle-exit; it fires after completion', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const { clock, exits, client } = await wire(async () => {
    await gate;
    return {
      ok: true,
      results: [{ name: 'find_definition', error: { kind: 'op_threw', message: 'stub' } }],
    };
  }, true);
  assert.ok(client);

  const callP = client.callTool({ name: 'op', arguments: { name: 'find_definition' } });
  await flush();
  await flush(); // let the server handler enter()
  clock.advance(5000); // past TTL — must not reap the live call
  await flush();
  assert.deepEqual(exits, [], 'no exit while a request is in flight');

  release();
  await callP; // request completes → finally leave() re-arms
  await flush();
  clock.advance(1001);
  await flush();
  assert.deepEqual(exits, [0], 'idle-exit fires once the request is done');
});

test('serveMcp: a THROWING request still releases the in-flight count (finally), so idle-exit fires', async () => {
  const { clock, exits, client } = await wire(async () => {
    throw new Error('boom');
  }, true);
  assert.ok(client);
  // The handler catches the throw (returns an error payload) — the point is `finally { leave() }`
  // runs on that path too. Were leave() only on the success return, inFlight would stay >0 and the
  // server could never idle-exit — the orphan would persist (the exact bug Stage 1 fixes).
  await client.callTool({ name: 'op', arguments: { name: 'find_definition' } });
  await flush();
  clock.advance(1001);
  await flush();
  assert.deepEqual(exits, [0]);
});
