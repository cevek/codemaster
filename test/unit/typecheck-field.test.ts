// The mutating-op §2.8 gate diffs post-edit diagnostics against a pre-edit baseline. Oracle:
// hand-built diagnostic sets with a known introduced/pre-existing split — including the
// MULTISET trap (TS emits several diagnostics collapsing to one (file,line,message), differing
// only by column, which the key drops). A set-based diff would mask the introduced occurrence
// and write a broken edit as clean; the gate must count, not just test membership.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTypecheckField } from '../../src/ops/mutation-support.ts';
import type { TsDiagnostic } from '../../src/plugins/ts/plugin.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

const d = (file: string, line: number, message: string): TsDiagnostic => ({
  file: file as RepoRelPath,
  line,
  message,
});

test('clean when the edit introduces nothing; pre-existing errors ride as a count', () => {
  const r = buildTypecheckField([d('a.ts', 1, 'X')], [d('a.ts', 1, 'X')]);
  assert.equal(r.clean, true);
  assert.deepEqual(r.field, { clean: true, preExisting: 1 });
});

test('an introduced error is surfaced; pre-existing stays a separate count', () => {
  const r = buildTypecheckField([d('a.ts', 1, 'X')], [d('a.ts', 1, 'X'), d('b.ts', 9, 'Y')]);
  assert.equal(r.clean, false);
  const f = r.field as { clean: boolean; introduced: { file: string }[]; preExisting?: number };
  assert.equal(f.clean, false);
  assert.deepEqual(f.introduced, [{ file: 'b.ts', line: 9, message: 'Y' }]);
  assert.equal(f.preExisting, 1);
});

test('MULTISET: a 2nd occurrence of a pre-existing (file,line,message) is INTRODUCED, not masked', () => {
  // baseline has ONE `Cannot find name 'Bar'` on a.ts:1; the edit makes it fire TWICE (same
  // line, differing only by column). A set diff would absorb both → false clean → broken write.
  const r = buildTypecheckField(
    [d('a.ts', 1, "Cannot find name 'Bar'.")],
    [d('a.ts', 1, "Cannot find name 'Bar'."), d('a.ts', 1, "Cannot find name 'Bar'.")],
  );
  assert.equal(r.clean, false, 'the surplus occurrence is a NEW error, must not be masked');
  const f = r.field as { introduced: unknown[]; preExisting?: number };
  assert.equal(f.introduced.length, 1);
  assert.equal(f.preExisting, 1, 'exactly one occurrence was pre-existing');
});

test('introduced list is capped with moreIntroduced; never reads clean while dropping', () => {
  const after: TsDiagnostic[] = [];
  for (let i = 0; i < 25; i++) after.push(d('a.ts', i + 1, `E${i}`));
  const r = buildTypecheckField([], after);
  assert.equal(r.clean, false);
  const f = r.field as { introduced: unknown[]; moreIntroduced?: number };
  assert.equal(f.introduced.length, 20);
  assert.equal(f.moreIntroduced, 5);
});
