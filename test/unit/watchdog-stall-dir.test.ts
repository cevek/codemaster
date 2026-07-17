// Watchdog stall writer (t-095661). Writes the breadcrumb diagnostic; a write failure returns null
// (never throws — a wedged process must still be SIGKILLed even if the diagnostic can't persist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeStallRecord, type StallRecord } from '../../src/support/watchdog/stall-dir.ts';

const RECORD: StallRecord = {
  reason: 'wedge',
  pid: 4242,
  op: 'op:find_usages {"name":"X"}',
  startMs: 1000,
  elapsedMs: 305_000,
  seq: 7,
  ts: 1_700_000_000_000,
};

test('writeStallRecord: writes a parseable JSON record and returns its path', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-stall-'));
  try {
    const file = writeStallRecord(path.join(dir, 'stalls'), RECORD);
    assert.ok(file !== null, 'returns the written path');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StallRecord;
    assert.deepEqual(parsed, RECORD, 'round-trips every field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStallRecord: returns null (never throws) when the dir cannot be created', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-stall-'));
  try {
    // A regular FILE stands where the stall dir would go → mkdirSync fails ENOTDIR under it.
    const asFile = path.join(dir, 'not-a-dir');
    writeFileSync(asFile, 'x');
    const result = writeStallRecord(path.join(asFile, 'stalls'), RECORD);
    assert.equal(result, null, 'a failed write is null, not a throw');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
