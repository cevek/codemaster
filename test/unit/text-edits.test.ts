// Stage A oracle for support/text-edits/. The oracle for `applyEdits` is a hand-computed
// expected string (not the implementation re-run); for conflict detection it is the known
// geometry of the edit set; for `writeFileAtomic` it is the on-disk state after a forced
// failure (original intact, no temp partial left behind).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEdits, type TextEdit } from '../../src/support/text-edits/apply.ts';
import { findConflict, EditConflictError } from '../../src/support/text-edits/conflict.ts';
import { emitQuoted } from '../../src/support/text-edits/quote.ts';
import { writeFileAtomic } from '../../src/support/text-edits/write.ts';

test('applyEdits: hand-computed splices, order-independent', () => {
  const src = 'const a = 1; const b = 2;';
  // Replace `a`→`alpha` (idx 6-7) and `b`→`beta` (idx 19-20); pass out of order.
  const edits: TextEdit[] = [
    { start: 19, end: 20, text: 'beta' },
    { start: 6, end: 7, text: 'alpha' },
  ];
  assert.equal(applyEdits(src, edits), 'const alpha = 1; const beta = 2;');
  // Empty edit set is identity.
  assert.equal(applyEdits(src, []), src);
  // Pure insert (start === end) and pure delete (text === '').
  assert.equal(applyEdits('abc', [{ start: 1, end: 1, text: 'X' }]), 'aXbc');
  assert.equal(applyEdits('abc', [{ start: 1, end: 2, text: '' }]), 'ac');
});

test('applyEdits: coincident delete+insert pair is allowed and deterministic', () => {
  // The LS "rename" shape: delete [3,5) and insert at [3,3); the insert text lands where the
  // deleted span was. With an empty delete this is order-insensitive — the next test pins the
  // insert-text-before-delete-text ordering against a NON-empty delete.
  const pair: TextEdit[] = [
    { start: 3, end: 5, text: '' }, // delete "cd"
    { start: 3, end: 3, text: 'XY' }, // insert before
  ];
  assert.equal(findConflict(pair), null); // a zero-length side → allowed
  assert.equal(applyEdits('ab cd ef', pair), 'ab XY ef');
});

test('applyEdits: coincident insert+delete keeps insert-text BEFORE delete-text', () => {
  // A NON-empty delete at the same anchor as an insert — the contract is insert-text then
  // delete-text (the single-pass preserves what the prior mutate-and-reslice produced).
  const pair: TextEdit[] = [
    { start: 3, end: 5, text: 'DEL' }, // replace "cd" → DEL
    { start: 3, end: 3, text: 'INS' }, // insert at the same start
  ];
  assert.equal(findConflict(pair), null);
  assert.equal(applyEdits('ab cd ef', pair), 'ab INSDEL ef');
});

test('applyEdits: N coincident zero-length inserts at ONE offset apply in array order (import-merge shape)', () => {
  // The exact shape the TS "Move to file" refactor emits when merging names into an existing
  // multi-line import: several zero-length inserts at the SAME offset, meant to apply in array
  // order. The prior mutate-and-reslice loop interleaved them — producing the field-reported
  // `,,` / missing-comma. Hand-computed oracle: 'a' + ',X,Y' + 'b'. A reslice loop yields
  // 'aY,X,b' (wrong), so this discriminates the fix.
  const inserts: TextEdit[] = [
    { start: 1, end: 1, text: ',' },
    { start: 1, end: 1, text: 'X' },
    { start: 1, end: 1, text: ',' },
    { start: 1, end: 1, text: 'Y' },
  ];
  assert.equal(findConflict(inserts), null); // all zero-length → coincident-allowed
  assert.equal(applyEdits('ab', inserts), 'a,X,Yb');
});

test('applyEdits: a MIXED batch of coincident + disjoint edits in one call (equivalence lock)', () => {
  // Disjoint edits must behave exactly as before (the fix only changes coincident handling). One
  // call mixing a replace at [0,1), two coincident inserts at 2, and a replace at [3,4) — passed
  // out of order. Hand-computed: A→a, X then Y between B and C, D→d ⇒ 'aBXYCd'.
  const mixed: TextEdit[] = [
    { start: 3, end: 4, text: 'd' },
    { start: 2, end: 2, text: 'X' },
    { start: 0, end: 1, text: 'a' },
    { start: 2, end: 2, text: 'Y' },
  ];
  assert.equal(findConflict(mixed), null);
  assert.equal(applyEdits('ABCD', mixed), 'aBXYCd');
});

test('findConflict: two NON-empty edits sharing a start conflict (no silent clobber)', () => {
  // Both claim characters at [2,4); merging them would corrupt the result.
  const sameStart: TextEdit[] = [
    { start: 2, end: 4, text: 'XX' },
    { start: 2, end: 6, text: 'YYYY' },
  ];
  assert.ok(findConflict(sameStart));
  assert.throws(() => applyEdits('abcdefghij', sameStart), EditConflictError);
});

test('applyEdits: adjacent touching ranges do not conflict', () => {
  // [0,2) and [2,4) border but share no character.
  assert.equal(
    applyEdits('abcd', [
      { start: 0, end: 2, text: 'AB' },
      { start: 2, end: 4, text: 'CD' },
    ]),
    'ABCD',
  );
  assert.equal(
    findConflict([
      { start: 0, end: 2, text: 'x' },
      { start: 2, end: 4, text: 'y' },
    ]),
    null,
  );
});

test('applyEdits / findConflict: overlapping ranges are reported, never clobbered', () => {
  const overlapping: TextEdit[] = [
    { start: 0, end: 5, text: 'x' },
    { start: 3, end: 8, text: 'y' },
  ];
  assert.ok(findConflict(overlapping));
  assert.throws(() => applyEdits('0123456789', overlapping), EditConflictError);

  // Enclosing range overlapping a NON-adjacent edit (caught by running-max sweep).
  const enclosing: TextEdit[] = [
    { start: 0, end: 100, text: 'a' },
    { start: 1, end: 2, text: 'b' }, // coincident-free but inside [0,100)
    { start: 50, end: 51, text: 'c' },
  ];
  assert.ok(findConflict(enclosing));
});

test('emitQuoted: preserves single, double, and backtick styles; escapes', () => {
  assert.equal(emitQuoted("import x from 'old';", 14, './new'), "'./new'");
  assert.equal(emitQuoted('import x from "old";', 14, './new'), '"./new"');
  assert.equal(emitQuoted('import x from `old`;', 14, './new'), '`./new`');
  // Escapes the same quote char inside the payload.
  assert.equal(emitQuoted("'x'", 0, "a'b"), "'a\\'b'");
  // Non-quote position → defensive JSON.stringify fallback.
  assert.equal(emitQuoted('x', 0, './new'), '"./new"');
});

test('emitQuoted: escapes backslash, newline, and template interpolation', () => {
  // Backslash must be doubled or the emitted literal misrepresents its value.
  assert.equal(emitQuoted("'x'", 0, 'a\\b'), "'a\\\\b'");
  assert.equal(emitQuoted('"x"', 0, 'a\\b'), '"a\\\\b"');
  // Raw newline → escaped \n, never a hard break inside a single-quoted literal.
  assert.equal(emitQuoted("'x'", 0, 'a\nb'), "'a\\nb'");
  // Template `${` would inject an expression — must be escaped; a bare backtick too.
  assert.equal(emitQuoted('`x`', 0, '${x}'), '`\\${x}`');
  assert.equal(emitQuoted('`x`', 0, 'a`b'), '`a\\`b`');
  // A lone trailing backslash must not escape the closing delimiter.
  assert.equal(emitQuoted('"x"', 0, 'end\\'), '"end\\\\"');
});

test('writeFileAtomic: happy path creates file + parent dirs, no temp left', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-te-'));
  try {
    const target = path.join(dir, 'nested', 'deep', 'file.ts');
    const r = writeFileAtomic(target, 'export const x = 1;\n');
    assert.ok(r.ok);
    assert.equal(readFileSync(target, 'utf8'), 'export const x = 1;\n');
    assert.deepEqual(readdirSync(path.dirname(target)), ['file.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'writeFileAtomic: forced failure leaves original intact, no partial',
  { skip: process.getuid?.() === 0 },
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-te-'));
    const sub = path.join(dir, 'ro');
    mkdirSync(sub);
    const target = path.join(sub, 'file.ts');
    writeFileSync(target, 'ORIGINAL\n', 'utf8');
    chmodSync(sub, 0o555); // read-only dir → temp create fails
    try {
      const r = writeFileAtomic(target, 'CLOBBERED\n');
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.failure.tool, 'fs');
      chmodSync(sub, 0o755);
      assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL\n'); // untouched
      assert.deepEqual(readdirSync(sub), ['file.ts']); // no .tmp partial
    } finally {
      chmodSync(sub, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
