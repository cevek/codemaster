// The file/module hint is a `Result` string: folding it into a lesson must not change a byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileModuleHint } from '../../src/ops/search-file-hint.ts';

test('the hint keeps its exact wording, including the quoted file in the suggested call', () => {
  assert.equal(
    fileModuleHint('foo', { files: ['src/foo.ts'], total: 1 }),
    " — but a source file named 'foo' exists (src/foo.ts); if you meant the FILE/module rather than a symbol, try find_definition {file:'src/foo.ts'}.",
  );
});
