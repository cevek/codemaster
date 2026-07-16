// The `common/truncate` chokepoint (t-188210): the single home for every truncation idiom, each
// site co-producing an explicit §3.4 marker. Oracle-backed — the expected marker / envelope is
// recomputed from the input independently of the function under test (never a golden echo).

import test from 'node:test';
import assert from 'node:assert/strict';
import { elideString } from '../../src/common/truncate/elide-string.ts';
import { elideType } from '../../src/common/truncate/elide-type.ts';
import { capList } from '../../src/common/truncate/cap-list.ts';
import { nameWithMore } from '../../src/common/truncate/name-with-more.ts';
import { CAP_DESCRIPTORS, capFor } from '../../src/common/truncate/cap-ids.ts';

test('elideString: at/under cap returns verbatim (elided:false, no marker)', () => {
  const r = elideString('short', 200);
  assert.deepEqual(r, { text: 'short', elided: false, total: 5 });
  const edge = elideString('a'.repeat(200), 200);
  assert.equal(edge.elided, false, 'exactly-cap is NOT elided (<=)');
});

test('elideString: over cap cuts with a trailing … and reports the FULL length', () => {
  const s = 'x'.repeat(250);
  const r = elideString(s, 200);
  assert.equal(r.elided, true);
  assert.equal(r.total, 250, 'total is the pre-cut length');
  assert.equal(r.text, `${'x'.repeat(200)}…`, 'shown = first 200 chars + the base … marker');
  assert.equal(r.text.length, 201, 'exactly cap chars + one ellipsis');
});

test('elideType: rich verbosity marker matches the hand-built recovery string (expand-type-type)', () => {
  const s = 'y'.repeat(300);
  const got = elideType(s, 'expand-type-type', 'normal');
  assert.equal(got, `${'y'.repeat(200)}… (type elided: 300 chars — verbosity:full)`);
});

test('elideType: signature recovery names both verbosity:full and expand_type (expand-type-signature)', () => {
  const s = 'z'.repeat(300);
  const got = elideType(s, 'expand-type-signature', 'normal');
  assert.equal(
    got,
    `${'z'.repeat(200)}… (signature elided: 300 chars — verbosity:full, or expand_type the param type)`,
  );
});

test('elideType: verbosity:full lifts the cap for a verbosity-aware CapId (10000 bound, under it = verbatim)', () => {
  const s = 'y'.repeat(300);
  assert.equal(
    elideType(s, 'expand-type-type', 'full'),
    s,
    'under the full cap → verbatim, no marker',
  );
  const huge = 'y'.repeat(10_500);
  const cut = elideType(huge, 'expand-type-type', 'full');
  assert.ok(cut.endsWith('(type elided: 10500 chars — verbosity:full)'), 'full still bounded (§1)');
});

test('elideType: length-only twin reports length ALONE — no verbosity:full steer (§3.6)', () => {
  const s = 'w'.repeat(300);
  for (const capId of ['first-param-member-type', 'overlay-type', 'type-widening'] as const) {
    const got = elideType(s, capId, 'normal');
    assert.equal(got, `${'w'.repeat(200)}… (type elided: 300 chars)`, `${capId} marker`);
    assert.ok(!got.includes('verbosity:full'), `${capId} must not offer verbosity:full`);
    // A twin has no valueFull → `full` reuses `value`, so the cap is NOT lifted (op never threads it).
    assert.equal(elideType(s, capId, 'full'), got, `${capId} cap is not verbosity-aware`);
  }
});

test('capFor: value at default, valueFull at full only when the descriptor is verbosity-aware', () => {
  assert.equal(capFor(CAP_DESCRIPTORS['expand-type-type'], 'normal'), 200);
  assert.equal(capFor(CAP_DESCRIPTORS['expand-type-type'], 'full'), 10_000);
  assert.equal(
    capFor(CAP_DESCRIPTORS['type-widening'], 'full'),
    200,
    'no valueFull → value at full',
  );
});

test('capList: under cap ships no truncation; over cap co-produces {shown,total,hint}', () => {
  const items = Array.from({ length: 5 }, (_, i) => i);
  const under = capList(items, 10, 'raise limit');
  assert.deepEqual(under, { shown: [0, 1, 2, 3, 4] });
  assert.equal(under.truncation, undefined, 'no envelope when nothing was cut');

  const over = capList(items, 3, 'raise limit');
  assert.deepEqual(over.shown, [0, 1, 2]);
  assert.deepEqual(over.truncation, { shown: 3, total: 5, hint: 'raise limit' });
});

test('capList: cap === undefined returns the whole list uncapped (sql-mode, never a silent partial)', () => {
  const items = [1, 2, 3];
  const r = capList(items, undefined, 'unused');
  assert.deepEqual(r.shown, items);
  assert.equal(r.truncation, undefined);
  assert.notEqual(r.shown, items, 'returns a copy, not the source array');
});

test('nameWithMore: at/under k joins whole; over k appends the exact remainder count', () => {
  assert.equal(nameWithMore([], 3), '', 'empty in → empty out (no false hint)');
  assert.equal(nameWithMore(['a', 'b'], 3), 'a, b');
  assert.equal(nameWithMore(['a', 'b', 'c'], 3), 'a, b, c', 'exactly-k has no +more');
  assert.equal(nameWithMore(['a', 'b', 'c', 'd', 'e'], 3), 'a, b, c, +2 more');
});
