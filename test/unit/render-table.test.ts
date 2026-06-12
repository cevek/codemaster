// SQL-table cell rendering (review fixes #4, #5). The `|`-delimited row must stay
// unambiguous: a cell containing `|` (or newline / padding / emptiness) is quoted via
// JSON; NULL renders as a stable `∅` token, distinct from an empty string `""`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSqlTable, isSqlTableData } from '../../src/format/render/render-table.ts';

test('#4 a cell containing the delimiter is quoted; the row stays parseable', () => {
  const out = renderSqlTable({ columns: ['sig', 'n'], rows: [['a | b', 1]] });
  const rowLine = out.split('\n')[1];
  assert.ok(rowLine !== undefined);
  assert.match(rowLine, /^"a \| b" \| 1$/, 'the | inside the value is wrapped in quotes');
  // The bare delimiter splits to exactly 2 fields (quotes shield the inner one).
  assert.equal(rowLine.split('" | ').length, 2);
});

test('#5 NULL renders as ∅; an empty string renders as "" (distinguishable)', () => {
  const out = renderSqlTable({ columns: ['encloser', 'name'], rows: [[null, '']] });
  const rowLine = out.split('\n')[1];
  assert.equal(rowLine, '∅ | ""', 'NULL → ∅, empty string → quoted ""');
});

test('a literal ∅ string is quoted so it cannot masquerade as NULL', () => {
  const out = renderSqlTable({ columns: ['c'], rows: [['∅']] });
  assert.equal(out.split('\n')[1], '"∅"');
});

test('ordinary values pass through bare; header carries the row count', () => {
  const out = renderSqlTable({ columns: ['encloser', 'count'], rows: [['Widget', 3]] });
  assert.match(out, /^encloser \| count {2}\(1 row\)$/m);
  assert.match(out, /^Widget \| 3$/m);
});

test('isSqlTableData detects the shape and rejects others', () => {
  assert.equal(isSqlTableData({ columns: ['a'], rows: [[1]] }), true);
  assert.equal(isSqlTableData({ matches: [] }), false);
  assert.equal(isSqlTableData([1, 2, 3]), false);
});
