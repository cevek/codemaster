// spec-status-as-the-doc §3 guard #3: "the example-validation test keeps covering every
// example SHOWN." The per-op examples are oracle-checked by the Stage 1.1 anti-drift test,
// but the `concepts` block carries its own worked `sql` call — and the golden snapshot
// catches an edited string, NOT a schema drift (rename the `encloser` column or a `role`
// value and the example would lie while every test stayed green). This guards the names
// that worked example depends on against the live op catalogue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinOps } from '../../src/ops/builtins.ts';
import { CONCEPTS_LINES } from '../../src/format/render/concepts.ts';

test('the concepts sql worked-example references a real op and column', () => {
  const example = CONCEPTS_LINES.find((l) => l.includes('SELECT encloser'));
  assert.ok(example !== undefined, 'the concepts sql example must be present');

  // It builds two `find_usages` tables and joins on the `encloser` column.
  const findUsages = builtinOps().find((o) => o.name === 'find_usages');
  assert.ok(findUsages !== undefined, 'concepts example names find_usages — it must exist');
  assert.ok(example.includes('name:"find_usages"'), 'example uses find_usages');
  assert.ok(
    findUsages.table?.columns.some((c) => c.name === 'encloser'),
    'concepts example selects `encloser` — find_usages must project that column',
  );

  // The roles named in the example must be real role values the schema accepts.
  assert.ok(
    findUsages.argsSchema.safeParse({ symbols: ['Input'], role: 'jsx', groupBy: 'enclosing' })
      .success,
    'the role/groupBy used in the example must validate',
  );
});
