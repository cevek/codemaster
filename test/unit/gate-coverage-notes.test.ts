// The advisory note of the §2.8 gate (t-401540): each extends-only base config is diffed on its own,
// so an error that disappears under one base and appears under another is still reported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepoRelPath } from '../../src/core/brands.ts';
import type { TsDiagnostic } from '../../src/plugins/ts/diagnostics.ts';
import { gateCoverageNotes } from '../../src/ops/mutation-support.ts';

const err: TsDiagnostic = {
  file: 'consumer.ts' as RepoRelPath,
  line: 2,
  message: "Type 'string' is not assignable to type 'number'.",
};

test('an error moving from one advisory base to another is introduced, not cancelled', () => {
  const [note] = gateCoverageNotes({
    programs: ['tsconfig.json'],
    degraded: [],
    skipped: ['tsconfig.a.json', 'tsconfig.b.json'],
    advisory: [
      { baseline: [err], overlay: [] },
      { baseline: [], overlay: [err] },
    ],
  });
  assert.match(note ?? '', /1 error\(s\) introduced under them do NOT block.*consumer\.ts:2/);
});

test('an error both baseline and overlay of one base carry is not introduced', () => {
  const [note] = gateCoverageNotes({
    programs: ['tsconfig.json'],
    degraded: [],
    skipped: ['tsconfig.base.json'],
    advisory: [{ baseline: [err], overlay: [err] }],
  });
  assert.match(note ?? '', /no error introduced under them/);
});
