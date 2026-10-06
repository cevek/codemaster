// The process host's failure cause across a darwin system sleep (t-833715): its kill timer counts
// sleep, so a "did not reply in 150000ms" may describe a child that ran for ten seconds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessHost } from '../../src/daemon/process-host.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { RepoId } from '../../src/core/brands.ts';
import { manualClock } from '../helpers/project.ts';

/** One request that fails after `elapseMs` of wall clock — by the kill timer (`deadline`) or a bare
 *  SIGKILL exit before it (`crash`) — with the machine's last sleep at `[start+sleptAt,
 *  start+wokeAt]`. Returns the failure's tool and message. */
async function failedAcrossSleep(
  elapseMs: number,
  sleep: { sleptAt: number; wokeAt: number },
): Promise<{ tool: string; message: string }> {
  const clock = manualClock();
  const t0 = clock.now();
  let onMessage: ((raw: JsonValue) => void) | undefined;
  let onExit: ((code: number | null, signal: string | null) => void) | undefined;
  const spawned = createProcessHost({
    repoId: 'r' as RepoId,
    clock,
    spawn: () => ({
      pid: 1,
      send: () => undefined,
      kill: () => undefined,
      onMessage: (cb) => (onMessage = cb),
      onExit: (cb) => (onExit = cb),
    }),
    startupDeadlineMs: 1_000,
    requestDeadlineMs: 150_000,
    disposeDeadlineMs: 100,
    onExit: () => undefined,
    lastSuspension: () =>
      Promise.resolve({ sleptAtMs: t0 + sleep.sleptAt, wokeAtMs: t0 + sleep.wokeAt }),
  });
  onMessage?.({ kind: 'ready' });
  const p = await spawned;
  assert.ok(p.ok);
  const reqP = p.host.request([{ name: 'extract_symbol', args: {} as never }]);
  clock.advance(elapseMs);
  onExit?.(null, 'SIGKILL');
  const r0 = (await reqP)[0];
  assert.ok(r0 !== undefined && 'result' in r0 && !r0.result.ok);
  return { tool: r0.result.failure.tool, message: r0.result.failure.message };
}

test('deadline across a sleep: the cause says the machine slept, not that the engine worked 150 s', async () => {
  // The incident: ~10 s awake, 449 s asleep, the kill timer fires on wake at 460 s.
  const slept = await failedAcrossSleep(460_000, { sleptAt: 10_000, wokeAt: 459_000 });
  assert.equal(slept.tool, 'timeout');
  assert.match(
    slept.message,
    /did not reply in 150000ms — killed it; the machine slept ≥449s of this 460s window/,
  );
  assert.match(slept.message, /retry is not expected to time out/);
  // A sleep that ended before the request began explains nothing.
  const awake = await failedAcrossSleep(150_000, { sleptAt: -500_000, wokeAt: -1_000 });
  assert.equal(awake.tool, 'timeout');
  assert.doesNotMatch(awake.message, /slept/);
});

test('a non-timeout death across a sleep is annotated too — the child watchdog can win the race on wake', async () => {
  const died = await failedAcrossSleep(100_000, { sleptAt: 5_000, wokeAt: 99_000 });
  assert.equal(died.tool, 'engine-process');
  assert.match(died.message, /exited \(code=null signal=SIGKILL\); the machine slept ≥94s/);
  assert.doesNotMatch(died.message, /retry/, 'no deadline ran out — no conclusion about one');
});
