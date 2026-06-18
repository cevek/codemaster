// `target` as the SymbolId alias of `symbol` (DX feedback): agents naturally address a held
// handle under `target`, and the old strictObject rejected it as bad_args. The alias is collapsed
// to `symbol` at the one resolver chokepoint, so EVERY symbol-addressed op accepts either spelling.
//
// Oracle: the alias must produce the SAME answer as the canonical `symbol` form AND match the
// hand-curated semantic ground truth (the fixture is input; the expected set is written here, not
// read back from a second LS — §16). An alias that silently changed the result would be the §3 lie
// this guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number; col: number }; role: string };

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/Button.tsx':
    'export interface Props { size: string }\n' +
    'export const Button = (p: Props) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    "import { Button as B } from './Button';\n" + 'export const App = () => <B size="lg" />;\n',
};

function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
function definitionId(r: OpResult): string {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  const id = (r.result.data as { definition?: { id?: string } }).definition?.id;
  assert.ok(typeof id === 'string' && id.startsWith('ts:'), `expected a ts: SymbolId, got ${id}`);
  return id;
}
const projset = (u: Usage[]): string[] =>
  u.map((x) => `${x.span.file}:${x.span.line}:${x.role}`).sort();

test('find_usages accepts target as the alias of symbol — identical to the symbol form and to ground truth', async () => {
  const p: TestProject = await project(FILES);
  try {
    // Mint a real SymbolId via the canonical `symbol`-yielding path.
    const id = definitionId(await p.op('find_usages', { name: 'Button', collapseImports: false }));

    const bySymbol = usagesOf(await p.op('find_usages', { symbol: id, collapseImports: false }));
    const byTarget = usagesOf(await p.op('find_usages', { target: id, collapseImports: false }));

    // Equivalence: the alias resolves to the same symbol, same answer.
    assert.deepEqual(projset(byTarget), projset(bySymbol), 'target form == symbol form');

    // Independent oracle: the hand-read semantic set for Button under this fixture.
    assert.deepEqual(
      projset(byTarget),
      [
        'src/App.tsx:1:import',
        'src/App.tsx:1:import',
        'src/App.tsx:2:jsx',
        'src/Button.tsx:2:decl',
      ].sort(),
      'target form returns EXACTLY the hand-curated semantic set',
    );
  } finally {
    await p.dispose();
  }
});

test('the alias is honored across symbol-addressed ops (not just find_usages) and no longer bad_args', async () => {
  const p: TestProject = await project(FILES);
  try {
    const id = definitionId(await p.op('find_usages', { name: 'Button', collapseImports: false }));

    // A DIFFERENT op proves the alias lives at the shared resolver, not in find_usages alone.
    const def = await p.op('find_definition', { target: id });
    assert.ok(
      'result' in def && def.result.ok,
      `target accepted by find_definition: ${JSON.stringify(def)}`,
    );
    const defs =
      (def.result.data as { definitions?: { span: { file: string } }[] }).definitions ?? [];
    assert.ok(
      defs.some((d) => d.span.file === 'src/Button.tsx'),
      'find_definition by target resolves to the declaration',
    );

    // The old failure mode: {target:'ts:…'} rejected as bad_args. It must now dispatch.
    const r = await p.op('find_usages', { target: id });
    assert.ok('result' in r, `target must dispatch, never bad_args: ${JSON.stringify(r)}`);
  } finally {
    await p.dispose();
  }
});
