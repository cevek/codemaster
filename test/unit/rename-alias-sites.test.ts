// Oracle for `findReExportAliasSites` — the alias half of the rename-completeness signal (KS-1).
// It must find EXACTLY the `export { <new> as <old> }` re-export specifiers the LS introduces to
// preserve a public name, and nothing else. The cases are hand-written to pin the behaviours two
// bug-reviewers flagged when this was a text regex: a value/type-position `as` must NOT
// false-positive, a comment/string must NOT false-positive, and a `$`/unicode identifier must NOT
// be silently missed. Inputs are already-formatted source strings; `text` is asserted verbatim so
// a span that drifts off its identifier fails (§3.2).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findReExportAliasSites } from '../../src/plugins/ts/refactor/rename/rename-sites.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

const F = 'x.ts' as RepoRelPath;
const find = (
  content: string,
  nw = 'renderLabel',
  old = 'formatLabel',
): ReturnType<typeof findReExportAliasSites> => findReExportAliasSites(F, content, nw, old);

void describe('findReExportAliasSites — AST, not text scan', () => {
  test('finds a real re-export alias, with the verbatim span', () => {
    const spans = find(`export { renderLabel as formatLabel } from './y';`);
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.text, 'renderLabel as formatLabel');
    assert.equal(spans[0]?.line, 1);
    assert.equal(spans[0]?.col, 10); // after `export { `
  });

  test('finds multiple aliases across the file', () => {
    const spans = find(
      `export { renderLabel as formatLabel } from './a';\nexport { renderLabel as formatLabel } from './b';`,
    );
    assert.deepEqual(
      spans.map((s) => s.line),
      [1, 2],
    );
  });

  test('does NOT match a value/type-position `as` (regex false-positive)', () => {
    assert.equal(find(`fn(renderLabel as formatLabel, y);`).length, 0);
    assert.equal(find(`const o = { a: renderLabel as formatLabel };`).length, 0);
    assert.equal(find(`const v = renderLabel as formatLabel;`).length, 0);
  });

  test('does NOT match inside a comment or string literal', () => {
    assert.equal(find(`// export { renderLabel as formatLabel } from './y';`).length, 0);
    assert.equal(find(`const s = "renderLabel as formatLabel }";`).length, 0);
  });

  test('does NOT match an aliased IMPORT (re-export only; LS never aliases imports on rename)', () => {
    assert.equal(find(`import { renderLabel as formatLabel } from './y';`).length, 0);
  });

  test('finds `$`/unicode identifiers a `\\b`-anchored regex would miss', () => {
    assert.equal(
      find(`export { $render as formatLabel } from './y';`, '$render', 'formatLabel').length,
      1,
    );
    assert.equal(
      find(`export { renderLabel as old$ } from './y';`, 'renderLabel', 'old$').length,
      1,
    );
    assert.equal(find(`export { rénder as café } from './y';`, 'rénder', 'café').length, 1);
  });

  test('does NOT match a plain re-export (no alias) or a different alias', () => {
    assert.equal(find(`export { formatLabel } from './y';`).length, 0);
    assert.equal(find(`export { renderLabel } from './y';`).length, 0);
    assert.equal(find(`export { renderLabel as somethingElse } from './y';`).length, 0);
  });
});
