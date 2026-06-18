// Daemon socket path (spec-daemon-singleton §19): short, hashed, length-asserted, per-version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketPath, assertSocketPathLength } from '../../src/support/transport/socket-path.ts';

test('socketPath: deterministic per (version, baseDir), .sock under the base dir', () => {
  const a = socketPath('0.1.0', '/tmp/rt');
  assert.equal(a, socketPath('0.1.0', '/tmp/rt'), 'stable for the same inputs');
  assert.ok(a.startsWith('/tmp/rt/'), 'lives under the base dir');
  assert.ok(a.endsWith('.sock'));
});

test('socketPath: a version bump yields a different socket (old daemon idle-exits)', () => {
  assert.notEqual(socketPath('0.1.0', '/tmp/rt'), socketPath('0.2.0', '/tmp/rt'));
});

test('assertSocketPathLength: passes a short path, throws an honest error on an over-long one', () => {
  assert.doesNotThrow(() => assertSocketPathLength('/tmp/rt/cm-0123456789abcdef.sock'));
  const tooLong = '/' + 'x'.repeat(120) + '.sock';
  assert.throws(() => assertSocketPathLength(tooLong), /socket path too long/);
});

test('assertSocketPathLength: counts BYTES, not characters (multibyte base dir)', () => {
  // 60 multibyte chars (3 bytes each in UTF-8) = 180 bytes — over the limit though only 60 "chars".
  const multibyte = '/' + 'あ'.repeat(60) + '.sock';
  assert.ok(multibyte.length < 100, 'fewer than 100 CHARS');
  assert.throws(() => assertSocketPathLength(multibyte), /≥ 100 bytes/);
});
