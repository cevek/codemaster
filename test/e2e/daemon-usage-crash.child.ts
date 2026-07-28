// Child process for the daemon crash-breadcrumb oracle (daemon-usage-crash.test.ts). Runs the REAL
// `serveDaemon` over a REAL unix socket with the REAL file usage logger, so the breadcrumb path
// under test is the production one.
//
// `crash` mode: the stub orchestrator SIGKILLs its own process synchronously inside `request` —
// provably AFTER the daemon stamped its pre-dispatch breadcrumb and BEFORE the dispatch returns to
// clear it. SIGKILL is uncatchable, so no handler, flush or `finally` can rescue it: exactly the
// shape of a daemon that dies with a call in flight. No timer to tune, no race.
//
// `ok` mode: every request succeeds, so the daemon clears its breadcrumb normally — the arm that
// proves a served call leaves nothing behind (and that the daemon writes no records of its own).
//
// `slow` mode + a tiny `TEST_IDLE_MS`: the dispatch outlives the client. The connection-level idle
// hold is released the moment that client disconnects, so without the request-level hold the idle
// deadline fires MID-DISPATCH and the daemon exits gracefully with a breadcrumb still on disk —
// which the next start would promote as a FABRICATED fatal.

import process from 'node:process';
import { systemClock } from '../../src/common/async/clock.ts';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import { defaultUsageLogger } from '../../src/support/usage-log/default.ts';
import { serveDaemon } from '../../src/daemon/daemon-server.ts';
import type { ServingOrchestrator } from '../../src/daemon/orchestrator-api.ts';

/** Dispatch duration in `slow` mode — comfortably longer than the idle TTL that arm sets. */
const SLOW_DISPATCH_MS = 1_500;

const mode = process.argv[2] ?? 'crash';
const socket = process.argv[3];
if (socket === undefined) {
  process.stderr.write('daemon-usage-crash.child: socket path required\n');
  process.exit(2);
}

const orchestrator = {
  sourceStale: () => false,
  daemonInfo: () => ({}) as never,
  dispose: async () => undefined,
  status: async () => ({}) as never,
  request: async (_cwd: string, _root: string | undefined, reqs: readonly { name: string }[]) => {
    if (mode === 'crash') process.kill(process.pid, 'SIGKILL');
    // Long enough to outlast the tiny idle TTL the `slow` arm configures, so the race is driven, not
    // hoped for.
    if (mode === 'slow') await new Promise((r) => setTimeout(r, SLOW_DISPATCH_MS));
    return {
      ok: true as const,
      results: reqs.map((r) => ({ name: r.name, result: { ok: true as const, data: {} } })),
    };
  },
} as unknown as ServingOrchestrator;

await serveDaemon({
  orchestrator,
  transport: createUnixSocketTransport(socket),
  clock: systemClock,
  // Default is far above the test's lifetime, so idle-exit never ends this child and each arm
  // observes only the shutdown path it drives itself. The `slow` arm overrides it to a tiny value
  // precisely to make idle-exit race the dispatch.
  idleMs: Number(process.env['TEST_IDLE_MS']) || 10 * 60_000,
  usage: defaultUsageLogger(),
});
process.stdout.write('listening\n');
