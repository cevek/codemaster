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
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { UsageLogEntry } from '../../src/support/usage-log/entry.ts';
import { defaultUsageLogger } from '../../src/support/usage-log/default.ts';
import { inflightDir, promoteOrphanInflight } from '../../src/support/usage-log/inflight.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHILD = path.join(repoRoot, 'test', 'e2e', 'usage-log-crash.child.ts');

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
  // A breadcrumb owned by THIS (alive) process, promoted from a different notional pid.
  const logger = defaultUsageLogger({ CODEMASTER_USAGE_DIR: dir } as NodeJS.ProcessEnv);
  logger.begin({
    ts: Date.now(),
    tool: 'find_usages',
    ops: ['find_usages'],
    cwd: '/x',
    args: null,
  });
  const promoted = promoteOrphanInflight(
    dir,
    () => assert.fail('promoted a live call'),
    Date.now(),
    -1,
  );
  assert.equal(promoted, 0);
  assert.equal(breadcrumbs(dir).length, 1);
  logger.dispose();
});
