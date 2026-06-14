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

test('a stale handle whose symbol is deleted is GONE — empty data, never a false rebind (§6)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/util.ts': 'export const onlyhere = (n: number) => n * 2;\n',
    'src/a.ts': "import { onlyhere } from './util.ts';\nexport const a = onlyhere(1);\n",
  });
  try {
    const search = await p.op('search_symbol', { query: 'onlyhere' });
    assert.ok('result' in search && search.result.ok);
    const id = (search.result.data as { matches: { id: string }[] }).matches[0]?.id;
    assert.ok(id !== undefined);

    // Delete the declaration AND its only user → no symbol of this name anywhere.
    p.write('src/util.ts', 'export const somethingElse = 1;\n');
    p.write('src/a.ts', 'export const a = 1;\n');

    // Every SymbolId-taking read op states the gone handle uniformly (one surfacing it and
    // the others flattening would be an inconsistent §6 signal).
    for (const op of ['find_usages', 'find_definition', 'expand_type'] as const) {
      const r = await p.op(op, { symbol: id });
      assert.ok('result' in r, `${op}: ${JSON.stringify(r)}`);
      assert.ok(!r.result.ok, `${op}: a gone symbol yields no answer`);
      assert.equal(r.result.data, undefined, `${op}: empty data — a guess would be the §6 lie`);
      assert.ok(r.result.handle !== undefined, `${op}: the gone status is stated, never silent`);
      assert.equal(r.result.handle.status, 'gone', `${op}: truly absent — not a silent retarget`);
    }

    // `source` is multi-target — the gone handle is stated per target in `unresolved`.
    const src = await p.op('source', { targets: [{ symbol: id }] });
    assert.ok('result' in src && src.result.ok);
    const un = (src.result.data as { unresolved?: { handle?: { status: string } }[] }).unresolved;
    assert.equal(un?.[0]?.handle?.status, 'gone', 'source states the gone handle per target');
  } finally {
    await p.dispose();
  }
});

test('a deleted symbol with a same-named sibling rebinds at PARTIAL confidence, never a silent retarget (§6)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/util.ts': 'export const dup = (n: number) => n * 2;\n',
    'src/other.ts': 'export const dup = (n: number) => n * 3;\n', // same name, UNRELATED
  });
  try {
    const search = await p.op('search_symbol', { query: 'dup' });
    assert.ok('result' in search && search.result.ok);
    const matches = (search.result.data as { matches: { id: string; span: { file: string } }[] })
      .matches;
    const utilId = matches.find((m) => m.span.file === 'src/util.ts')?.id;
    assert.ok(utilId !== undefined);

    // Remove util.ts's `dup`; other.ts still has a same-named one the rebind can reach
    // workspace-wide. That rebind is honest ONLY if it admits identity is unproven.
    p.write('src/util.ts', 'export const removed = 1;\n');

    const r = await p.op('find_usages', { symbol: utilId });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    assert.ok(r.result.handle !== undefined, 'the workspace-wide rebind is stated, never silent');
    assert.equal(r.result.handle.status, 'rebound');
    if (r.result.handle.status === 'rebound') {
      assert.equal(
        r.result.handle.confidence,
        'partial',
        'identity to a same-named sibling is NOT proven — never claimed certain',
      );
      assert.match(
        r.result.handle.note ?? '',
        /not proven/,
        'the unproven identity is said outright',
      );
    }
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
