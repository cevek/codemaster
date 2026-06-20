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
  // `~shape` is the render dispatch tag stamped on every diagnostic row (stripped from json mode,
  // consumed by the text renderer) — it rides on the live envelope data by design (gardrail a).
  assert.deepEqual(f.introduced, [
    { file: 'b.ts', line: 9, message: 'Y', '~shape': 'ts-diagnostic' },
  ]);
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

test('§1b: a moved file’s own pre-existing error is NOT counted as introduced (path re-key)', () => {
  // The whole file `old.ts` moved to `new.ts`, carrying its pre-existing error verbatim (same
  // line + message, new path). Without the re-key the baseline keys on old.ts and the after on
  // new.ts → the identical error reads as "introduced" and a sound move is refused (the P58 bug:
  // 602 = 596 + 6). With the move's old→new remap it matches the baseline and drops out.
  const remap = (f: string): string => (f === 'old.ts' ? 'new.ts' : f);
  const baseline = [d('old.ts', 5, "Type 'X' is not assignable to 'Y'.")];
  const after = [d('new.ts', 5, "Type 'X' is not assignable to 'Y'.")];

  const withoutRemap = buildTypecheckField(baseline, after);
  assert.equal(
    withoutRemap.clean,
    false,
    'guard: without the re-key the relocated error mis-reads as introduced',
  );

  const r = buildTypecheckField(baseline, after, remap);
  assert.equal(r.clean, true, 'a relocated-but-identical error must not block the move');
  assert.deepEqual(r.field, { clean: true, preExisting: 1 });
});

test('§1b: a folder move re-keys errors under the moved prefix; an unrelated new error still surfaces', () => {
  const remap = (f: string): string =>
    f.startsWith('src/old/') ? `src/new/${f.slice('src/old/'.length)}` : f;
  const baseline = [d('src/old/a.ts', 2, 'E1'), d('src/old/sub/b.ts', 3, 'E2')];
  // both pre-existing errors relocate with the folder; plus a genuinely new error in an importer.
  const after = [
    d('src/new/a.ts', 2, 'E1'),
    d('src/new/sub/b.ts', 3, 'E2'),
    d('importer.ts', 9, 'NEW'),
  ];
  const r = buildTypecheckField(baseline, after, remap);
  assert.equal(r.clean, false);
  const f = r.field as { introduced: { file: string }[]; preExisting?: number };
  assert.deepEqual(f.introduced, [
    { file: 'importer.ts', line: 9, message: 'NEW', '~shape': 'ts-diagnostic' },
  ]);
  assert.equal(f.preExisting, 2, 'both relocated errors ride as pre-existing, not introduced');
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
