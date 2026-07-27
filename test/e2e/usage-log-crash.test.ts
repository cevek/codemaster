// Crash telemetry, real-process oracle (t-807677). The usage log used to write ONE record, AFTER
// dispatch returned — so a call that KILLED the serving process (the in-process OOM this repo hit
// on a large monorepo) left nothing at all in `fail.jsonl`, and any triage driven off that log
// under-counted fatals to zero. The oracle is the only one that can prove the fix: a real child
// process is SIGKILLed mid-dispatch (uncatchable — no handler, no flush, no `finally` can rescue
// it), and the NEXT start of a usage logger over the same dir must materialize a fail record that
// NAMES the op that was in flight. Reading a golden or grepping source could not distinguish this
// from a fix that only works when the process cooperates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { serveMcp } from '../../src/mcp/server.ts';
import type { UsageLogEntry } from '../../src/support/usage-log/entry.ts';
import { defaultUsageLogger } from '../../src/support/usage-log/default.ts';
import { createFileUsageLogger } from '../../src/support/usage-log/create.ts';
import { inflightDir, promoteOrphanInflight } from '../../src/support/usage-log/inflight.ts';
import type { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { defineOp, type AnyOpDefinition } from '../../src/ops/registry.ts';

process.setMaxListeners(50);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD = path.join(repoRoot, 'test', 'e2e', 'usage-log-crash.child.ts');

function stubOp(): AnyOpDefinition {
  return defineOp({
    name: 'find_definition',
    summary: 'stub',
    mutating: false,
    requires: [],
    argsSchema: z.looseObject({}),
    argsHint: '{ }',
    run: async () => ({ ok: true, data: {} }),
  });
}

/** An orchestrator that answers every request successfully — the telemetry seam is what's on
 *  trial in these arms, not dispatch. */
function throwingOrchestrator(): Orchestrator {
  return {
    sourceStale: () => false,
    dispose: async () => undefined,
    status: async () => ({}) as never,
    request: async (_c: string, _r: string | undefined, reqs: readonly { name: string }[]) => ({
      ok: true as const,
      results: reqs.map((q) => ({ name: q.name, result: { ok: true as const, data: {} } })),
    }),
  } as unknown as Orchestrator;
}

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

/** Run the child in `crash` (SIGKILL mid-op) or `clean` (call completes) mode; resolve on exit. */
async function runChild(
  dir: string,
  mode: 'crash' | 'clean',
): Promise<{ code: number | null; signal: string | null }> {
  const child = spawn('node', [CHILD, mode], {
    cwd: repoRoot,
    env: { ...process.env, CODEMASTER_USAGE_DIR: dir, CODEMASTER_WATCHDOG: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => (stderr += c));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child hung (${mode}); stderr: ${stderr}`));
    }, 30_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (mode === 'clean' && code !== 0)
        reject(new Error(`clean child failed (${code}): ${stderr}`));
      else resolve({ code, signal });
    });
  });
}

test('a SIGKILL mid-dispatch is materialized as a crash record NAMING the op at the next start', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-crash-'));

  const { signal } = await runChild(dir, 'crash');
  assert.equal(signal, 'SIGKILL', 'the child must actually have been killed, not exited normally');

  // The dead call wrote NOTHING through the ordinary path — that is the bug's whole shape.
  assert.deepEqual(readEntries(path.join(dir, 'success.jsonl')), []);
  assert.deepEqual(readEntries(path.join(dir, 'fail.jsonl')), []);
  // …but a breadcrumb survived it.
  assert.equal(breadcrumbs(dir).length, 1, 'the in-flight breadcrumb must survive the kill');

  // The next start of a usage logger over the same dir promotes it.
  defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv).dispose();

  const fails = readEntries(path.join(dir, 'fail.jsonl'));
  assert.equal(fails.length, 1, 'exactly one crash record');
  const entry = fails[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.outcome, 'crash');
  assert.equal(entry.ok, false);
  assert.equal(entry.tool, 'find_definition');
  assert.deepEqual(
    entry.ops,
    ['find_definition'],
    'the record must NAME the op that was in flight',
  );
  assert.equal(entry.durationMs, null, 'the moment of death is unknown — no fabricated duration');
  assert.equal(entry.cwd, repoRoot, 'the repo that killed the process must be attributable');
  assert.deepEqual(
    entry.args,
    { name: 'Widget' },
    'the args that triggered the fatal are recovered',
  );
  // The ordinary key-set is intact, so existing jq consumers keep working.
  for (const key of [
    'ts',
    'durationMs',
    'tool',
    'ops',
    'ok',
    'cwd',
    'args',
    'response',
    'isError',
  ]) {
    assert.ok(key in entry, `crash record is missing the ordinary key '${key}'`);
  }

  // Idempotent: promoting again invents no second fatal, and the breadcrumb is gone.
  defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv).dispose();
  assert.equal(readEntries(path.join(dir, 'fail.jsonl')).length, 1, 'a fatal must be counted ONCE');
  assert.deepEqual(breadcrumbs(dir), []);
});

test('a call that COMPLETES leaves no breadcrumb — no phantom crash at the next start', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-clean-'));
  await runChild(dir, 'clean');

  assert.equal(readEntries(path.join(dir, 'success.jsonl')).length, 1);
  assert.deepEqual(breadcrumbs(dir), []);

  defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv).dispose();
  assert.deepEqual(readEntries(path.join(dir, 'fail.jsonl')), [], 'no fabricated crash record');
});

test("a LIVE sibling process's breadcrumb is never promoted (that would invent a fatal)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-live-'));
  // A breadcrumb owned by THIS (alive) process, reconciled from a different notional pid.
  const logger = defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv);
  const now = Date.now();
  logger.begin({ ts: now, tool: 'find_usages', ops: ['find_usages'], cwd: '/x', args: null });
  const out = promoteOrphanInflight(dir, () => assert.fail('promoted a live call'), now, 999_001);
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
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), start + 7 * 3_600_000, 999_001);
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
    999_001,
  );
  assert.equal(out.promoted, 0);
  assert.equal(breadcrumbs(dir).length, 1, 'a fresh unreadable breadcrumb must survive');
  // Only once it is far too old to belong to any writer is it reaped.
  promoteOrphanInflight(dir, () => undefined, now + 7 * 3_600_000, 999_001);
  assert.deepEqual(breadcrumbs(dir), []);
});

test('a claim left by a promoter that itself died is recovered, not lost forever', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-claim-'));
  mkdirSync(inflightDir(dir), { recursive: true });
  const now = Date.now();
  const rec = { ts: now, tool: 'impact', ops: ['impact'], cwd: '/r', args: null, pid: 999_999 };
  writeFileSync(path.join(inflightDir(dir), `999999-${now}-0.json`), JSON.stringify(rec), 'utf8');

  // Pass 1 — a promoter that claims the breadcrumb and then dies before recording it. The claimed
  // NAME must come from the module itself, not be hand-written: a claim name the promoter's own
  // scan cannot see is exactly the regression this arm exists to pin.
  promoteOrphanInflight(
    dir,
    () => {
      throw new Error('promoter died mid-promotion');
    },
    now,
    999_001,
  );
  const left = readdirSync(inflightDir(dir));
  assert.equal(left.length, 1, 'the claim must remain on disk');
  assert.ok(left[0]?.includes('.claiming-999001'), 'and it must be OUR claim');
  assert.deepEqual(breadcrumbs(dir), left, 'a claim MUST stay visible to the promoter’s own scan');

  // Pass 2 — a later start (the claimer, pid 999001, is not a live process) recovers it.
  const entries: UsageLogEntry[] = [];
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), now, 999_002);
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
      pid: 999999,
    };
    writeFileSync(path.join(inflightDir(dir), `999999-${base + i}-0.json`), JSON.stringify(rec));
  }
  const entries: UsageLogEntry[] = [];
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), Date.now(), 999_001);
  assert.deepEqual({ ...out }, { promoted: 200, deferred: 5 }, 'the cap is disclosed, not silent');
  assert.equal(
    entries[0]?.tool,
    'op0',
    'oldest first — the longest-waiting fatal is reported first',
  );
  assert.equal(breadcrumbs(dir).length, 5, 'the rest wait for a later start, never dropped');
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
    pid: 999_999,
  };
  writeFileSync(path.join(inflightDir(dir), `999999-${ts}-0.json`), JSON.stringify(orphan));

  const entries: UsageLogEntry[] = [];
  const out = promoteOrphanInflight(dir, (e) => entries.push(e), Date.now(), 999_001);
  assert.equal(out.promoted, 1, 'the orphan behind 250 live entries must still be promoted');
  assert.equal(entries[0]?.tool, 'find_usages');
  assert.equal(breadcrumbs(dir).length, 250, "the live sibling's breadcrumbs are left alone");
});

test('a throwing `record` still clears the breadcrumb — no phantom crash for an answered call', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-usage-throw-'));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const file = createFileUsageLogger(dir);
  await serveMcp(throwingOrchestrator(), 'test', {
    transport: serverT,
    ops: [stubOp()],
    usage: {
      begin: (call) => file.begin(call),
      record: () => {
        throw new Error('telemetry sink exploded');
      },
      dispose: () => file.dispose(),
    },
  });
  const client = new Client({ name: 'throw-test', version: '0' });
  await client.connect(clientT);
  const res = await client.callTool({ name: 'find_definition', arguments: { name: 'X' } });
  assert.ok(res !== undefined, 'a telemetry failure must never surface to the agent');
  assert.deepEqual(
    breadcrumbs(dir),
    [],
    'the breadcrumb must be cleared even when record() throws',
  );
});

test('a throwing `begin` never reaches the agent (the telemetry seam is injected, not trusted)', async () => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await serveMcp(throwingOrchestrator(), 'test', {
    transport: serverT,
    ops: [stubOp()],
    usage: {
      begin: () => {
        throw new Error('breadcrumb sink exploded');
      },
      record: () => undefined,
      dispose: () => undefined,
    },
  });
  const client = new Client({ name: 'begin-test', version: '0' });
  await client.connect(clientT);
  const res = (await client.callTool({ name: 'find_definition', arguments: {} })) as {
    isError?: boolean;
  };
  assert.notEqual(res.isError, true, 'a telemetry throw must not become the agent-visible answer');
});
