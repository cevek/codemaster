// NDJSON framing (spec-daemon-singleton §18) — pure, no sockets. Oracle: the decoder must
// reassemble exactly the messages the encoder produced, across arbitrary chunk boundaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeLine, createLineDecoder } from '../../src/support/transport/ndjson.ts';
import type { JsonValue } from '../../src/core/json.ts';

test('ndjson: encode → decode round-trips one message', () => {
  const decoder = createLineDecoder();
  const msg: JsonValue = { kind: 'request', n: 42, nested: { a: [1, true, null] } };
  assert.deepEqual(decoder.push(encodeLine(msg)), [msg]);
});

test('ndjson: multiple messages in one chunk decode in order', () => {
  const decoder = createLineDecoder();
  const chunk = encodeLine({ i: 1 }) + encodeLine({ i: 2 }) + encodeLine({ i: 3 });
  assert.deepEqual(decoder.push(chunk), [{ i: 1 }, { i: 2 }, { i: 3 }]);
});

test('ndjson: a message split across chunks is buffered until its newline', () => {
  const decoder = createLineDecoder();
  const line = encodeLine({ hello: 'world' });
  const mid = Math.floor(line.length / 2);
  assert.deepEqual(decoder.push(line.slice(0, mid)), [], 'partial line yields nothing yet');
  assert.deepEqual(decoder.push(line.slice(mid)), [{ hello: 'world' }]);
});

test('ndjson: a string containing a newline survives framing (escaped by JSON)', () => {
  const decoder = createLineDecoder();
  const msg: JsonValue = { text: 'line1\nline2' };
  // One encoded line despite the embedded newline, and it decodes back to one message.
  const encoded = encodeLine(msg);
  assert.equal(encoded.split('\n').filter((s) => s !== '').length, 1);
  assert.deepEqual(decoder.push(encoded), [msg]);
});

test('ndjson: blank keep-alive lines are skipped, not parsed as JSON', () => {
  const decoder = createLineDecoder();
  assert.deepEqual(decoder.push('\n\n' + encodeLine({ ok: true }) + '\n'), [{ ok: true }]);
});

test('ndjson: a malformed line throws (caller reports via onError, link survives)', () => {
  const decoder = createLineDecoder();
  assert.throws(() => decoder.push('{not json}\n'), SyntaxError);
});

test('ndjson: an unterminated line past the cap throws (bounds the buffer — no OOM)', () => {
  const decoder = createLineDecoder(1024); // 1KB cap for the test
  // A blob with no terminator must not grow the buffer without bound (§1 never-crash).
  assert.throws(() => decoder.push('x'.repeat(2000)), /exceeded 1024 bytes/);
});

test('ndjson: the cap does not trip a long but PROPERLY-TERMINATED line', () => {
  const decoder = createLineDecoder(1024);
  // 900 chars + newline: under the cap once the terminator splits it off.
  const msg = { s: 'y'.repeat(880) };
  assert.deepEqual(decoder.push(encodeLine(msg)), [msg]);
});
