// Daemon-side crash telemetry, real-process oracle (t-305430). `daemon serve` kept no usage logger
// at all, so in the DEFAULT topology (bridge + daemon) nothing recorded what the DAEMON was doing
// when it died: the bridge outlives its daemon and writes an ordinary `ok:false` /
// "daemon connection closed" record, which carries no crash discriminator, so triage filtering on
// `outcome:'crash'` sees zero fatals.
//
// The ownership split under test — the agent-facing process owns call ACCOUNTING (one record per
// call), the daemon owns only its own in-flight BREADCRUMBS (`begin`/`clear`, never `record`) — is
// what keeps this from double-counting. All three arms are needed, and the negative ones are the
// load-bearing half:
//
//  1. crash    → a promoted record with outcome:'crash', origin:'daemon', naming the op in flight.
//                Fails before the fix (no logger → no breadcrumb → nothing to promote).
//  2. graceful → a served call plus a clean shutdown promotes NOTHING. Without this arm the suite is
//                green on an implementation that FABRICATES crashes, which is the worse failure:
//                `inflight.ts` exists to prevent inventing a fatal as much as losing one.
//  3. no double count → the daemon writes no ordinary record for a call it served, so it can never
//                add a second count to the bridge's.
//
// A real socket + a real SIGKILL are the only way to prove it: the kill is uncatchable, so nothing
// on the child's way out can rescue the record, and a stub/in-memory daemon could not distinguish
// this from a fix that only works when the process cooperates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnixSocketTransport } from '../../src/support/transport/unix-socket.ts';
import type { TransportConnection } from '../../src/support/transport/seam.ts';
import { promoteOrphanInflight, writeInflight } from '../../src/support/usage-log/inflight.ts';
import type { UsageLogEntry } from '../../src/support/usage-log/entry.ts';

/** A pid guaranteed not to be running: `kill(pid, 0)` yields ESRCH, so the promotion classifies the
 *  breadcrumb as a genuine crash rather than a live sibling's in-flight call. */
const DEAD_PID = 2 ** 22 - 1;

process.setMaxListeners(50);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD = path.join(repoRoot, 'test', 'e2e', 'daemon-usage-crash.child.ts');
const BUDGET_MS = 30_000;

interface Harness {
  usageDir: string;
  socket: string;
  child: ChildProcess;
  connection: TransportConnection;
  exited: Promise<void>;
  cleanup: () => void;
}

/** Await `p` under a bound, CLEARING the loser timer — an un-cancelled `setTimeout` in a
 *  `Promise.race` keeps node's loop alive for its full budget after the test has passed. */
async function within<T>(p: Promise<T>, budgetMs = BUDGET_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const bail = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([p, bail]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitFor(cond: () => boolean, budgetMs = BUDGET_MS): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** Spawn the real daemon child on its own socket + usage dir, and connect to it. The socket lives
 *  in its own temp dir (short path — a unix socket path is length-capped, §19). */
async function start(mode: 'crash' | 'ok' | 'slow', idleMs?: number): Promise<Harness> {
  const usageDir = mkdtempSync(path.join(os.tmpdir(), 'cm-dusage-'));
  const sockDir = mkdtempSync(path.join(os.tmpdir(), 'cm-dsock-'));
  const socket = path.join(sockDir, 's');
  const child = spawn(process.execPath, [CHILD, mode, socket], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEMASTER_USAGE_DIR: usageDir,
      ...(idleMs !== undefined ? { TEST_IDLE_MS: String(idleMs) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dead = false;
  const exited = new Promise<void>((resolve) =>
    child.on('exit', () => {
      dead = true;
      resolve();
    }),
  );
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));

  const bound = await waitFor(() => existsSync(socket) || dead);
  assert.ok(bound && !dead, `daemon child must bind ${socket}; stderr=${stderr}`);
  const connection = await createUnixSocketTransport(socket).connect();
  return {
    usageDir,
    socket,
    child,
    connection,
    exited,
    cleanup: () => {
      // Kill ONLY this test's own child, by its own pid.
      if (!dead && child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      rmSync(usageDir, { recursive: true, force: true });
      rmSync(sockDir, { recursive: true, force: true });
    },
  };
}

/** Promote whatever breadcrumbs the child left, exactly as a next process start would, and return
 *  every record the promotion produced. A FRESH dir for the sink keeps the promoted records
 *  separate from anything the child itself wrote — arm 3 reads the child's own files. */
function promoteFrom(usageDir: string): UsageLogEntry[] {
  const promoted: UsageLogEntry[] = [];
  promoteOrphanInflight(usageDir, (entry) => promoted.push(entry), Date.now());
  return promoted;
}

function readEntries(file: string): UsageLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as UsageLogEntry);
}

const REQUEST = {
  id: 1,
  kind: 'request' as const,
  cwd: '/tmp/some-client-repo',
  reqs: [{ name: 'find_definition', args: {} }],
};

test('daemon SIGKILLed with a call in flight → a promoted outcome:crash / origin:daemon record naming the op', async () => {
  const h = await start('crash');
  try {
    h.connection.send(REQUEST as never);
    // The child kills itself inside `request`; its exit is the signal the breadcrumb is orphaned.
    await within(h.exited);

    const promoted = promoteFrom(h.usageDir);
    const daemonSide = promoted.filter((e) => e.origin === 'daemon');
    assert.equal(
      daemonSide.length,
      1,
      `exactly one daemon-side fatal must be recovered, got ${JSON.stringify(promoted)}`,
    );
    const entry = daemonSide[0];
    assert.ok(entry !== undefined);
    assert.equal(entry.outcome, 'crash', 'the daemon pid is gone → provably crash, not abandoned');
    assert.deepEqual(entry.ops, ['find_definition'], 'the fatal names the op that was in flight');
    assert.equal(entry.tool, 'find_definition', 'a single-op dispatch is that op, not "batch"');
    assert.equal(entry.cwd, REQUEST.cwd, "the CLIENT's cwd, not the detached daemon's own");
    assert.equal(entry.ok, false, 'a fatal routes to fail.jsonl');
    assert.equal(entry.durationMs, null, 'the moment the call stopped is unknown — never a fake 0');
  } finally {
    h.cleanup();
  }
});

test('daemon serves a call then shuts down cleanly → promotes NOTHING (no fabricated fatal) and wrote no record of its own', async () => {
  const h = await start('ok');
  try {
    const replied = new Promise<void>((resolve) => h.connection.onMessage(() => resolve()));
    h.connection.send(REQUEST as never);
    await within(replied);

    // Graceful exit through the production path (the management `shutdown` envelope).
    h.connection.send({ id: 2, kind: 'shutdown' } as never);
    const gone = await waitFor(() => h.child.exitCode !== null || h.child.signalCode !== null);
    assert.ok(gone, 'the daemon child must exit on the shutdown envelope');

    // Arm 2: a served call left no breadcrumb, so a later start invents no fatal.
    const promoted = promoteFrom(h.usageDir);
    assert.deepEqual(
      promoted.filter((e) => e.origin === 'daemon'),
      [],
      'a cleanly-served call must never be promoted as a daemon fatal',
    );

    // Arm 3: the daemon is not the accounting owner — it wrote no ordinary record for the call it
    // served, so it can never double-count against the bridge's one record.
    const wrote = [
      ...readEntries(path.join(h.usageDir, 'success.jsonl')),
      ...readEntries(path.join(h.usageDir, 'fail.jsonl')),
    ];
    assert.deepEqual(
      wrote.filter((e) => e.ops.includes('find_definition')),
      [],
      `the daemon must record no call of its own, got ${JSON.stringify(wrote)}`,
    );
  } finally {
    h.cleanup();
  }
});

// The crash discriminator is only worth anything if a GRACEFUL exit provably cannot leave a
// breadcrumb. The daemon's idle hold is per-CONNECTION while dispatch is detached from the
// connection's lifetime, so a client that disconnects mid-call releases the hold and the idle
// deadline can fire with the op still running: the daemon exits cleanly, its breadcrumb survives,
// and the next start promotes a fatal that never happened. That is the fabricated-crash lie
// `inflight.ts` exists to prevent, and it also silently kills a live call.
//
// This arm drives it deterministically — a 1.5 s dispatch against a 150 ms idle TTL, with the client
// gone the instant the request is sent — and it is what makes arm 2 non-vacuous: arm 2 alone passes
// on an implementation that never clears breadcrumbs at all, because it never creates the leak.
test('client disconnects mid-dispatch with a tiny idle TTL → the daemon does NOT idle-exit under the in-flight call, so no fatal is fabricated', async () => {
  const h = await start('slow', 150);
  try {
    h.connection.send(REQUEST as never);
    // Drop the client immediately: the connection-level idle hold is released here, mid-dispatch.
    await h.connection.close();
    // Outlast the idle TTL AND the dispatch, so the daemon has every chance to exit early.
    await within(h.exited, 4_000);

    const promoted = promoteFrom(h.usageDir);
    assert.deepEqual(
      promoted.filter((e) => e.origin === 'daemon'),
      [],
      `an idle-exit must never race a live dispatch into a fabricated fatal, got ${JSON.stringify(promoted)}`,
    );
  } finally {
    h.cleanup();
  }
});

test('origin survives the promotion round-trip (readRecord reconstructs field-by-field and would otherwise drop it)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-origin-'));
  try {
    // A breadcrumb owned by a pid that cannot exist → the promotion sees a genuine orphan.
    writeInflight(
      dir,
      {
        ts: Date.now() - 1000,
        tool: 'find_usages',
        ops: ['find_usages'],
        cwd: '/tmp/x',
        args: null,
        origin: 'daemon',
      },
      DEAD_PID,
    );
    const promoted = promoteFrom(dir);
    assert.equal(promoted.length, 1, 'the orphan is promoted');
    assert.equal(promoted[0]?.origin, 'daemon', 'origin must survive readRecord → crashEntry');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
