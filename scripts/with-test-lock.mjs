#!/usr/bin/env node
// Machine-wide MUTEX (K=1) for CPU-saturating verification runs across agent worktrees.
//
// Why: many worker agents share one machine. Two full `npm test` runs (each >1 min, all cores)
// launched at once don't take 2×time — they thrash every CPU and stretch superlinearly. This
// serializes such runs: one holder at a time, the rest queue.
//
// Usage:  node scripts/with-test-lock.mjs -- <cmd...>
//   e.g.  node scripts/with-test-lock.mjs -- npm test
// Only wrap the full suite: tsc / eslint / knip do not saturate the cores. Targeted `node --test <file>` stays UNLOCKED.
//
// Lock file: $CM_TEST_LOCK or ~/.codemaster-orch/verify.lock. Atomic create via open('wx');
// a dead-holder (pid gone) or an over-aged lock (>STALE_MS) is stolen so a crashed run never
// wedges the queue. Released on exit + SIGINT/SIGTERM. Exits with the child's exit code.

import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, cpus } from 'node:os';
import * as path from 'node:path';

const LOCK = process.env.CM_TEST_LOCK ?? path.join(homedir(), '.codemaster-orch', 'verify.lock');
const STALE_MS = Number(process.env.CM_TEST_LOCK_STALE_MS ?? 20 * 60 * 1000); // steal a lock older than this
const POLL_MIN = 400;
const POLL_MAX = 1200;

const argv = process.argv.slice(2);
const dashDash = argv.indexOf('--');
const cmd = dashDash >= 0 ? argv.slice(dashDash + 1) : argv;
if (cmd.length === 0) {
  process.stderr.write('with-test-lock: no command (usage: with-test-lock.mjs -- <cmd...>)\n');
  process.exit(2);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const jitter = () => POLL_MIN + Math.floor(Math.random() * (POLL_MAX - POLL_MIN));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

mkdirSync(path.dirname(LOCK), { recursive: true });

function tryAcquire() {
  try {
    const fd = openSync(LOCK, 'wx'); // atomic exclusive create
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), cmd: cmd.join(' ') }));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Held — inspect for a dead/stale holder to steal.
    let rec;
    try {
      rec = JSON.parse(readFileSync(LOCK, 'utf8'));
    } catch {
      rec = undefined;
    }
    const dead = rec && typeof rec.pid === 'number' && !alive(rec.pid);
    const aged = rec && typeof rec.ts === 'number' && Date.now() - rec.ts > STALE_MS;
    // An unparseable lock may be a holder between open('wx') and its write: steal it only once old.
    let orphanedEmpty = false;
    if (!rec) {
      try {
        orphanedEmpty = Date.now() - statSync(LOCK).mtimeMs > 10_000;
      } catch {
        /* gone already — loop */
      }
    }
    if (orphanedEmpty || dead || aged) {
      try {
        unlinkSync(LOCK);
      } catch {
        /* another waiter stole it first — loop */
      }
    }
    return false;
  }
}

function release() {
  try {
    const rec = JSON.parse(readFileSync(LOCK, 'utf8'));
    if (rec && rec.pid === process.pid) unlinkSync(LOCK);
  } catch {
    /* not ours / already gone */
  }
}

let waited = 0;
while (!tryAcquire()) {
  const ms = jitter();
  if (waited === 0 || waited % 20000 < ms) {
    process.stderr.write(`with-test-lock: queued behind another verify run… (${cmd.join(' ')})\n`);
  }
  sleep(ms);
  waited += ms;
}

let released = false;
const releaseOnce = () => {
  if (!released) {
    released = true;
    release();
  }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    releaseOnce();
    process.exit(130);
  });
}

// Leave CPU headroom on the dev machine: a full `npm test` at node's default concurrency
// (= core count) saturates every core and makes the machine (editor, browser, the agent
// orchestration itself) crawl. Measured: concurrency = cores-4 runs at ~the same wall-time as
// max (the suite tail is wait-bound e2e, not CPU) AND avoids the CPU-contention flaky that
// over/full-subscription reintroduces. The npm test scripts read TEST_CONCURRENCY (unset =
// node default), so CI — which doesn't use this lock — still runs at full speed. An explicit
// TEST_CONCURRENCY in the environment wins.
const env = { ...process.env };
if (env.TEST_CONCURRENCY === undefined)
  env.TEST_CONCURRENCY = String(Math.max(2, cpus().length - 4));
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: false, env });
releaseOnce();
if (r.error) {
  process.stderr.write(`with-test-lock: spawn failed: ${r.error.message}\n`);
  process.exit(1);
}
process.exit(r.status ?? (r.signal ? 1 : 0));
