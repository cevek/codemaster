// End-to-end op correctness on assembled fixtures (§16): the aliased-JSX case grep
// misses, proof-span validity on every answer (invariant 1), explicit truncation, and
// the §6 proof-carrying rebind after the handle's file changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}';
const REACT_STUB = `export type ReactNode = unknown;\nexport declare namespace JSX { interface IntrinsicElements { [k: string]: unknown } }\n`;

test('find_usages catches aliased import + JSX usage (grep would miss it)', async () => {
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"jsx":"react-jsx","paths":{"react/jsx-runtime":["./jsx.d.ts"]},"baseUrl":"."}}',
    'jsx.d.ts': `declare module 'react/jsx-runtime' { export function jsx(t: unknown, p: unknown): unknown; export function jsxs(t: unknown, p: unknown): unknown; export namespace JSX { interface IntrinsicElements { [k: string]: unknown } interface Element {} } }\n`,
    'src/Button.tsx': `export const Button = (x: { size: string }) => <button>{x.size}</button>;\n`,
    'src/App.tsx': `import { Button as B } from './Button.tsx';\nexport const App = () => <B size="lg" />;\n`,
  });
  try {
    const r = await p.op('find_usages', { name: 'Button' });
    assert.ok('result' in r && r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
    const usages = (r.result.data as { usages: { span: { file: string; text: string } }[] }).usages;
    const files = new Set(usages.map((u) => u.span.file));
    assert.ok(files.has('src/Button.tsx'));
    assert.ok(files.has('src/App.tsx'), 'aliased <B/> usage must be found');
    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('truncation is explicit {shown,total}, never silent (§3.4)', async () => {
  const uses = Array.from({ length: 6 }, (_, i) => `export const u${i} = twice(${i});`).join('\n');
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/util.ts': 'export const twice = (n: number) => n * 2;\n',
    'src/many.ts': `import { twice } from './util.ts';\n${uses}\n`,
  });
  try {
    const r = await p.op('find_usages', { name: 'twice', limit: 3 });
    assert.ok('result' in r && r.result.ok);
    assert.ok(r.result.truncated !== undefined, 'cap must surface as truncation');
    assert.equal(r.result.truncated.shown, 3);
    assert.ok(r.result.truncated.total > 3);
  } finally {
    await p.dispose();
  }
});

test('a stale SymbolId rebinds with proof and stated confidence (§6)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/util.ts': 'export const twice = (n: number) => n * 2;\n',
    'src/a.ts': `import { twice } from './util.ts';\nexport const a = twice(1);\n`,
  });
  try {
    const search = await p.op('search_symbol', { query: 'twice' });
    assert.ok('result' in search && search.result.ok);
    const id = (search.result.data as { matches: { id: string }[] }).matches[0]?.id;
    assert.ok(id !== undefined);

    // Shift the definition down two lines — the handle's recorded position is stale.
    p.write('src/util.ts', '// moved\n// down\nexport const twice = (n: number) => n * 2;\n');

    const r = await p.op('find_usages', { symbol: id });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    assert.ok(r.result.handle !== undefined, 'rebind must be stated, never silent');
    assert.equal(r.result.handle.status, 'rebound');
    if (r.result.handle.status === 'rebound') {
      assert.equal(r.result.handle.confidence, 'partial'); // location proven, identity not
      assert.ok(r.result.handle.proof.text.includes('twice'));
    }
    const usages = (r.result.data as { usages: { span: { file: string } }[] }).usages;
    assert.ok(
      usages.some((u) => u.span.file === 'src/a.ts'),
      'answer computed against new home',
    );
    assertSpansValid(p.root, r);
  } finally {
    await p.dispose();
  }
});

test('unknown op and bad args fail with pointed messages, daemon stays up', async () => {
  const p = await project({ 'tsconfig.json': TSCONFIG, 'src/x.ts': 'export const x = 1;\n' });
  try {
    const unknown = await p.op('find_usage', {});
    assert.ok('error' in unknown && unknown.error.kind === 'unknown_op');
    assert.match(unknown.error.message, /did you mean 'find_usages'/);

    const bad = await p.op('find_usages', { limit: 5 });
    assert.ok('error' in bad && bad.error.kind === 'bad_args');

    const stillUp = await p.op('search_symbol', { query: 'x' });
    assert.ok('result' in stillUp && stillUp.result.ok);
  } finally {
    await p.dispose();
  }
});

void REACT_STUB;
