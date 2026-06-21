// Regression oracle for the multi-line import-merge bug (feedback 2026-06-21): moving a symbol
// into a dest whose existing import is MULTI-LINE made the TS "Move to file" refactor emit several
// zero-length inserts at ONE offset, which the prior `applyEdits` mutate-and-reslice loop
// interleaved into malformed syntax (a double comma + a missing comma in dest's import block). The
// dry-run §2.8 typecheck caught it and the op REFUSED — honest, never a half-write — but the
// capability was broken. Oracle: an INDEPENDENT cold `ts.Program` over the post-apply tree compiles
// clean (a `,,` is a syntax error it would report), and the move actually lands. Not golden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

// verbatimModuleSyntax + a generated-DTO `import type` alias path mirror the field repro shape.
const TSCONFIG =
  '{"compilerOptions":{"strict":true,"module":"preserve","verbatimModuleSyntax":true,"paths":{"@/*":["./src/*"]}}}';

type Envelope = { mode: string; diff: string; typecheck: { clean: boolean }; applied?: boolean };

async function move(p: TestProject, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'move_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('move_symbol: merging 2 type-imports into a MULTI-LINE dest import stays valid syntax', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api/generated/api-input-types.ts':
      'export type CancelV2SaleInputDto = { c: number };\n' +
      'export type CreateV2RefundInputDto = { d: number };\n' +
      'export type UpdateV2SaleInputDto = { a: number };\n' +
      'export type UpdateV2SaleItemInputDto = { b: number };\n',
    // dest already carries a MULTI-LINE type-import (the shape a prior chain move produced).
    'src/api/hooks/dest.ts':
      'import type {\n' +
      '    CancelV2SaleInputDto,\n' +
      '    CreateV2RefundInputDto,\n' +
      "} from '@/api/generated/api-input-types.ts';\n" +
      '\n' +
      'export const existing = (x: CancelV2SaleInputDto, y: CreateV2RefundInputDto): number =>\n' +
      '    x.c + y.d;\n',
    // the moved symbol needs TWO more names from the SAME module → the LS inserts both into dest's line.
    'src/api/hooks/source.ts':
      "import type { UpdateV2SaleInputDto, UpdateV2SaleItemInputDto } from '@/api/generated/api-input-types.ts';\n" +
      '\n' +
      'export const moved = (a: UpdateV2SaleInputDto, b: UpdateV2SaleItemInputDto): number => a.a + b.b;\n',
  });
  try {
    const dry = await move(p, { name: 'moved', dest: 'src/api/hooks/dest.ts' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true, `merge produced invalid syntax: ${dry.diff}`);
    assert.equal(p.git('status', '--porcelain'), ''); // dry-run wrote nothing

    const applied = await move(p, { name: 'moved', dest: 'src/api/hooks/dest.ts' }, true);
    assert.equal(applied.applied, true, `apply refused: ${JSON.stringify(applied)}`);
    assert.equal(applied.diff, dry.diff); // diff(dry-run) === diff(apply)

    // Independent oracle: a fresh cold ts.Program compiles clean — a `,,` / missing comma in the
    // merged import would be a syntax error it reports.
    assert.deepEqual(coldTscErrors(p.root), []);
    const dest = readFileSync(path.join(p.root, 'src/api/hooks/dest.ts'), 'utf8');
    assert.doesNotMatch(dest, /,\s*,/, 'no double comma in the merged import');
    // All four names present in dest's import block, the move landed, source lost the symbol.
    for (const n of [
      'CancelV2SaleInputDto',
      'CreateV2RefundInputDto',
      'UpdateV2SaleInputDto',
      'UpdateV2SaleItemInputDto',
    ]) {
      assert.match(dest, new RegExp(`\\b${n}\\b`), `dest import keeps ${n}`);
    }
    assert.match(dest, /export const moved/, 'symbol landed in dest');
  } finally {
    await p.dispose();
  }
});
