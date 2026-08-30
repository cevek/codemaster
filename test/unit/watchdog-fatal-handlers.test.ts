// Unit oracle for the fatal handlers (t-216182). The independent oracle is the seam contract:
// injected write/exit/stall sinks + a fake clock record exactly what the handler did, so each
// claim (never throws, host-gone exits, fault storm bounded, daemon stays up) is asserted against
// observed calls, never against the handler's own report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFatalHandler } from '../../src/support/watchdog/fatal-handlers.ts';
import type { StallRecord } from '../../src/support/watchdog/stall-dir.ts';

interface Recorded {
  exits: number[];
  stalls: StallRecord[];
  handler: ReturnType<typeof makeFatalHandler>;
}

function build(opts: {
  exitOnHostGone: boolean;
  writeThrows?: boolean;
  now?: () => number;
}): Recorded {
  const exits: number[] = [];
  const stalls: StallRecord[] = [];
  const handler = makeFatalHandler({
    label: 'test',
    exitOnHostGone: opts.exitOnHostGone,
    stallDir: '/nowhere',
    write: (): void => {
      if (opts.writeThrows === true)
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    },
    exit: (code): void => {
      exits.push(code);
    },
    writeStall: (_dir, record): string | null => {
      stalls.push(record);
      return null;
    },
    now: opts.now ?? ((): number => 1000),
  });
  return { exits, stalls, handler };
}

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

test('the handler never throws, even when its own write throws EPIPE (the storm arm)', () => {
  const r = build({ exitOnHostGone: false, writeThrows: true });
  assert.doesNotThrow(() => r.handler('exception', epipe()));
});

test('host-gone code + exitOnHostGone → one stall record (host-gone) then exit(1)', () => {
  const r = build({ exitOnHostGone: true });
  r.handler('exception', epipe());
  assert.deepEqual(r.exits, [1]);
  assert.equal(r.stalls.length, 1);
  assert.equal(r.stalls[0]?.reason, 'host-gone');
  assert.match(r.stalls[0]?.op ?? '', /EPIPE/);
});

test('host-gone as an unhandled REJECTION (async stdio write) exits the same way', () => {
  const r = build({ exitOnHostGone: true });
  r.handler('rejection', epipe());
  assert.deepEqual(r.exits, [1]);
  assert.equal(r.stalls[0]?.reason, 'host-gone');
});

test('exitOnHostGone:false (the daemon) survives an EPIPE — no exit, no host-gone record', () => {
  const r = build({ exitOnHostGone: false });
  r.handler('exception', epipe());
  assert.deepEqual(r.exits, []);
  assert.deepEqual(r.stalls, []);
});

test('a repeating fault storm ends in ONE fault-loop stall record + exit, never an unbounded swallow', () => {
  let t = 0;
  const r = build({ exitOnHostGone: false, now: () => (t += 100) });
  for (let i = 0; i < 25 && r.exits.length === 0; i += 1) r.handler('exception', new Error('boom'));
  assert.deepEqual(r.exits, [1], 'the storm was terminated');
  assert.equal(r.stalls.length, 1);
  assert.equal(r.stalls[0]?.reason, 'fault-loop');
});

test('sparse faults (outside the window) never trip the storm guard', () => {
  let t = 0;
  const r = build({ exitOnHostGone: false, now: () => (t += 60_000) });
  for (let i = 0; i < 50; i += 1) r.handler('exception', new Error('rare'));
  assert.deepEqual(r.exits, []);
  assert.deepEqual(r.stalls, []);
});

test('a non-Error rejection reason with a code string is still classified', () => {
  const r = build({ exitOnHostGone: true });
  r.handler('rejection', { code: 'ERR_STREAM_DESTROYED', message: 'gone' });
  assert.deepEqual(r.exits, [1]);
});
