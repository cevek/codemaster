// Folding rewrites explanation channels only: a trace hop's note quotes walked source, and a
// non-prose key carries data — both stay verbatim even when they spell a lesson exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldResult } from '../../src/format/render/fold-prose.ts';
import { tag } from '../../src/common/shape-tag/tag.ts';
import type { JsonValue } from '../../src/core/json.ts';

const LESSON =
  'target type is generic — assignability to the bare generic is not concretely proven';
const fold = (s: string): string => s.split(LESSON).join('FOLDED');

test('prose keys fold; trace-hop notes and data keys do not', () => {
  const hop = tag('trace-hop', { note: `used in an expression (p + "${LESSON}")` } as never);
  const r = foldResult(
    { ok: true, data: { note: LESSON, about: LESSON, hops: [hop] } as unknown as JsonValue },
    fold,
  );
  const d = r.data as { note: string; about: string; hops: { note: string }[] };
  assert.equal(d.note, 'FOLDED');
  assert.equal(d.about, LESSON);
  assert.ok(d.hops[0]?.note.includes(LESSON));
});
