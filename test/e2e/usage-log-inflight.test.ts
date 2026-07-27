// Crash-breadcrumb RECONCILIATION (t-807677) — the promotion half of the crash telemetry whose
// real-process oracle lives in `usage-log-crash.test.ts`. These arms pin the honesty rules a
// promotion pass must obey, each one a lie the module would otherwise tell: promoting a live
// sibling's call (a fabricated fatal), deleting a breadcrumb a live writer is still producing or
// leaving a dead promoter's claim invisible (a lost fatal), declaring a still-answering owner dead,
// letting a prefix of un-promotable entries starve a real orphan, and reading a capped pass as a
// complete one.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UsageLogEntry } from '../../src/support/usage-log/entry.ts';
import { defaultUsageLogger } from '../../src/support/usage-log/default.ts';
import { createFileUsageLogger } from '../../src/support/usage-log/create.ts';
import { inflightDir, promoteOrphanInflight } from '../../src/support/usage-log/inflight.ts';

/** A pid that is PROVABLY dead: spawn a process, wait for it to exit, reuse its pid. Hardcoding a
 *  "surely free" number is a CI flake waiting to happen — Linux's default `pid_max` is 4194304, so
 *  999_999 can be a live process there, and the arms that prove the fix would silently go green for
 *  the wrong reason (a live owner is skipped, never promoted). */
let DEAD_PID = 0;
before(() => {
  const done = spawnSync('node', ['-e', ''], { stdio: 'ignore' });
  assert.ok(done.pid !== undefined && done.pid > 0, 'could not obtain a dead pid');
  DEAD_PID = done.pid;
});

function readEntries(file: string): UsageLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as UsageLogEntry);
}

/** Surviving breadcrumb files (an absent dir = none), so an assertion failure reads semantically
 *  instead of as an ENOENT from `readdirSync`. */
function breadcrumbs(dir: string): string[] {
  try {
    return readdirSync(inflightDir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

test("a LIVE sibling process's breadcrumb is never promoted (that would invent a fatal)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-live-'));
  // A breadcrumb owned by THIS (alive) process, reconciled from a different notional pid.
  const logger = defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv);
  const now = Date.now();
  logger.begin({ ts: now, tool: 'find_usages', ops: ['find_usages'], cwd: '/x', args: null });
  const out = promoteOrphanInflight(
    dir,
    () => assert.fail('promoted a live call'),
    now,
    DEAD_PID + 1,
  );
  assert.deepEqual(out, { promoted: 0, deferred: 0 });
  assert.equal(breadcrumbs(dir).length, 1);
  logger.dispose();
});

test('a LIVE owner past the abandon age is reported as `abandoned`, never as a proven crash', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-abandon-'));
  const logger = defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv);
  const start = Date.now();
  logger.begin({ ts: start, tool: 'find_usages', ops: ['find_usages'], cwd: '/x', args: null });
  const entries: UsageLogEntry[] = [];
  // 7h later, with the owner (this very process) still alive.
  const out = promoteOrphanInflight(
    dir,
    (e) => entries.push(e),
    start + 7 * 3_600_000,
    DEAD_PID + 1,
  );
  assert.equal(out.promoted, 1);
  assert.equal(entries[0]?.outcome, 'abandoned', 'a live owner must not be declared dead');
  assert.match(String(entries[0]?.response), /NOT proven to have died/);
  logger.dispose();
});

test('a truncated breadcrumb from a LIVE writer is not deleted (that would lose a real fatal)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-partial-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  const now = Date.now();
  // A half-written file, as a pre-atomic-write reader would have seen it.
  writeFileSync(path.join(inflightDir(dir), `${process.pid}-${now}-0.json`), '{"ts":17', 'utf8');
  const out = promoteOrphanInflight(
    dir,
    () => assert.fail('promoted a corrupt record'),
    now,
    DEAD_PID + 1,
  );
  assert.equal(out.promoted, 0);
  assert.equal(breadcrumbs(dir).length, 1, 'a fresh unreadable breadcrumb must survive');
  // Only once it is far too old to belong to any writer is it reaped.
  promoteOrphanInflight(dir, () => undefined, now + 7 * 3_600_000, DEAD_PID + 1);
  assert.deepEqual(breadcrumbs(dir), []);
});

test('a claim left by a promoter that itself died is recovered, not lost forever', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-claim-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  const now = Date.now();
  const rec = { ts: now, tool: 'impact', ops: ['impact'], cwd: '/r', args: null, pid: DEAD_PID };
  writeFileSync(
    path.join(inflightDir(dir), `${DEAD_PID}-${now}-0.json`),
    JSON.stringify(rec),
    'utf8',
  );

  // Pass 1 — a promoter that claims the breadcrumb and then dies before recording it. The claimed
  // NAME must come from the module itself, not be hand-written: a claim name the promoter's own
  // scan cannot see is exactly the regression this arm exists to pin.
  promoteOrphanInflight(
    dir,
    () => {
      throw new Error('promoter died mid-promotion');
    },
    now,
    DEAD_PID + 1,
  );
  const left = readdirSync(inflightDir(dir));
  assert.equal(left.length, 1, 'the claim must remain on disk');
  assert.ok(left[0]?.includes(`.claiming-${DEAD_PID + 1}`), 'and it must be OUR claim');
  assert.deepEqual(breadcrumbs(dir), left, 'a claim MUST stay visible to the promoter’s own scan');

  // Pass 2 — a later start (the claimer, pid 999001, is not a live process) recovers it.
  const entries: UsageLogEntry[] = [];
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), now, DEAD_PID + 2);
  assert.equal(out.promoted, 1, 'an orphaned CLAIM must still be reconciled');
  assert.equal(entries[0]?.tool, 'impact');
  assert.match(
    String(entries[0]?.response),
    /may already have written a record/,
    'a re-claimed record must disclose that it can duplicate the dead promoter’s write',
  );
  assert.deepEqual(breadcrumbs(dir), []);
});

test('a breadcrumb write is atomic and leaves no stranded temp', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-atomic-'));
  const logger = createFileUsageLogger(dir);
  logger.begin({ ts: Date.now(), tool: 'source', ops: ['source'], cwd: '/r', args: null });
  const all = readdirSync(inflightDir(dir));
  assert.equal(all.length, 1, 'exactly one file — the breadcrumb, never a leftover temp');
  assert.ok(all[0]?.endsWith('.json'), 'a reader only ever meets the complete, renamed file');
  logger.dispose();
});

test('a capped promotion pass takes the OLDEST breadcrumbs and discloses what it deferred', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-cap-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  const base = Date.now() - 86_400_000;
  for (let i = 0; i < 205; i++) {
    const rec = {
      ts: base + i,
      tool: `op${i}`,
      ops: [`op${i}`],
      cwd: '/r',
      args: null,
      pid: DEAD_PID,
    };
    // The LEADING name segment is scattered on purpose: with a common prefix and equal-width
    // stamps, lexicographic readdir order already equals chronological order, and the oldest-first
    // assertion below would hold even with no sort at all.
    const namePid = 900_000 + ((i * 37 + 91) % 205);
    writeFileSync(
      path.join(inflightDir(dir), `${namePid}-${base + i}-0.json`),
      JSON.stringify(rec),
    );
  }
  const entries: UsageLogEntry[] = [];
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), Date.now(), DEAD_PID + 1);
  assert.deepEqual({ ...out }, { promoted: 200, deferred: 5 }, 'the cap is disclosed, not silent');
  assert.equal(
    entries[0]?.tool,
    'op0',
    'oldest first — the longest-waiting fatal is reported first',
  );
  assert.equal(breadcrumbs(dir).length, 5, 'the rest wait for a later start, never dropped');
});

test('a capped start DISCLOSES the deferral in the log — the crash count reads as a lower bound', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-disclose-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  const base = Date.now() - 86_400_000;
  for (let i = 0; i < 205; i++) {
    const rec = {
      ts: base + i,
      tool: 'source',
      ops: ['source'],
      cwd: '/r',
      args: null,
      pid: DEAD_PID,
    };
    writeFileSync(
      path.join(inflightDir(dir), `${DEAD_PID}-${base + i}-0.json`),
      JSON.stringify(rec),
    );
  }
  defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv).dispose();
  const fails = readEntries(path.join(dir, 'fail.jsonl'));
  const disclosure = fails.filter((e) => e.tool === 'usage-log-promotion');
  assert.equal(disclosure.length, 1, 'a capped pass must say so, never read as complete');
  assert.match(String(disclosure[0]?.response), /5 in-flight breadcrumb\(s\) not examined/);
  assert.equal(fails.length - disclosure.length, 200);
});

test('un-promotable entries do not eat the cap — a real orphan behind them is never starved', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-starve-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  // Fresh calls (well inside the abandon age) of a LIVE sibling — the normal state of a busy dir.
  const base = Date.now();
  for (let i = 0; i < 250; i++) {
    const rec = {
      ts: base + i,
      tool: 'live',
      ops: ['live'],
      cwd: '/r',
      args: null,
      pid: process.pid,
    };
    writeFileSync(
      path.join(inflightDir(dir), `${process.pid}-${base + i}-0.json`),
      JSON.stringify(rec),
    );
  }
  // …and ONE genuine orphan sorting after all of them.
  const ts = base + 500;
  const orphan = {
    ts,
    tool: 'find_usages',
    ops: ['find_usages'],
    cwd: '/r',
    args: null,
    pid: DEAD_PID,
  };
  writeFileSync(path.join(inflightDir(dir), `${DEAD_PID}-${ts}-0.json`), JSON.stringify(orphan));

  const entries: UsageLogEntry[] = [];
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), Date.now(), DEAD_PID + 1);
  assert.equal(out.promoted, 1, 'the orphan behind 250 live entries must still be promoted');
  assert.equal(entries[0]?.tool, 'find_usages');
  assert.equal(breadcrumbs(dir).length, 250, "the live sibling's breadcrumbs are left alone");
});

test('an aged temp left by a death between write and rename is swept, not accumulated forever', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-temp-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  const now = Date.now();
  const fresh = `${DEAD_PID}-${now}-0.tmp`;
  const aged = `${DEAD_PID}-${now - 7 * 3_600_000}-1.tmp`;
  writeFileSync(path.join(inflightDir(dir), fresh), '{"ts":1');
  writeFileSync(path.join(inflightDir(dir), aged), '{"ts":1');
  promoteOrphanInflight(dir, () => undefined, now, DEAD_PID + 1);
  const left = readdirSync(inflightDir(dir));
  // A temp is invisible to every other path (it is not `.json`), so nothing else would ever remove
  // it — but a FRESH one may belong to a writer mid-publish.
  assert.deepEqual(left, [fresh], 'the aged temp is swept; the fresh one is left alone');
});

test('a breadcrumb whose name is not ours is reaped, not left to eat the scan budget forever', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-foreign-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  writeFileSync(path.join(inflightDir(dir), 'not-our-format.json'), 'garbage');
  promoteOrphanInflight(dir, () => assert.fail('promoted garbage'), Date.now(), DEAD_PID + 1);
  assert.deepEqual(breadcrumbs(dir), [], 'an unparseable name has no age to wait out');
});

test('a failed breadcrumb write degrades to a no-op handle and strands nothing', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-nowrite-'));
  // The inflight PATH is occupied by a file, so the directory can never be created.
  writeFileSync(inflightDir(dir), 'in the way');
  const logger = createFileUsageLogger(dir);
  const handle = logger.begin({
    ts: Date.now(),
    tool: 'list',
    ops: ['list'],
    cwd: '/r',
    args: null,
  });
  handle.clear(); // must not throw either
  logger.dispose();
  assert.equal(readFileSync(inflightDir(dir), 'utf8'), 'in the way', 'nothing was written over it');
});
