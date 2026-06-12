// Generic graph primitives (agent-driven design): role-filtered usages, rollup to the
// enclosing declaration, search filters, importers_of. Oracle = the fixture we wrote:
// exactly which components render which primitives is known by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';

const FILES = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"jsx":"react-jsx","baseUrl":".","paths":{"react/jsx-runtime":["jsx.d.ts"],"@/*":["src/*"]}}}',
  'jsx.d.ts': `declare module 'react/jsx-runtime' { export function jsx(t: unknown, p: unknown): unknown; export function jsxs(t: unknown, p: unknown): unknown; export namespace JSX { interface IntrinsicElements { [k: string]: unknown } interface Element {} } }\n`,
  'src/ui/dialog.tsx': `export const DialogContent = (p: { children?: unknown }) => <div>{p.children}</div>;\n`,
  'src/features/Confirm.tsx': `import { DialogContent as DC } from '@/ui/dialog';\nexport const Confirm = () => (<DC><DC /></DC>);\n`,
  'src/features/Paid.tsx': `import { DialogContent } from '../ui/dialog';\nexport const Paid = () => <DialogContent>x</DialogContent>;\nconst grab = () => DialogContent; // read, not jsx\nexport const g = grab();\n`,
};

test('role=jsx + groupBy=enclosing: which components render X, aliased and deduped', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      symbols: ['DialogContent'],
      role: 'jsx',
      groupBy: 'enclosing',
      filter: { pathExclude: ['**/ui/**'] },
    });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const data = r.result.data as {
      targets: {
        symbol: string;
        enclosers: { id: string; count: number; roles: string }[];
        total: number;
      }[];
    };
    const target = data.targets[0];
    assert.ok(target !== undefined);
    const byName = new Map(target.enclosers.map((e) => [e.id.split('@')[0], e]));
    // Oracle by construction: Confirm renders 2 elements (aliased <DC>), Paid 1;
    // the closing </DC> must not inflate counts; the non-jsx read must not appear.
    assert.equal(byName.get('ts:Confirm')?.count, 2);
    assert.equal(byName.get('ts:Paid')?.count, 1);
    assert.equal(target.total, 3);
    assert.ok([...byName.values()].every((e) => e.roles === 'jsx'));
  } finally {
    await p.dispose();
  }
});

test('role=read finds the non-jsx reference jsx filtering hides', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('find_usages', { name: 'DialogContent', role: 'read' });
    assert.ok('result' in r && r.result.ok);
    const usages = (r.result.data as { usages: { span: { file: string } }[] }).usages;
    assert.equal(usages.length, 1);
    assert.equal(usages[0]?.span.file, 'src/features/Paid.tsx');
  } finally {
    await p.dispose();
  }
});

test('search_symbol filters: kind + exportedOnly + pathExclude', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('search_symbol', {
      query: 'D',
      kind: 'const',
      exportedOnly: true,
      pathExclude: ['**/ui/**'],
    });
    assert.ok('result' in r && r.result.ok);
    const matches = (r.result.data as { matches: { name: string }[] }).matches;
    assert.ok(!matches.some((m) => m.name === 'DialogContent'), 'ui/ must be excluded');
  } finally {
    await p.dispose();
  }
});

test('importers_of resolves aliased and relative specifiers to one module', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('importers_of', { module: '@/ui/dialog' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const data = r.result.data as { module: string; importers: { at: string; imports: string }[] };
    assert.equal(data.module, 'src/ui/dialog.tsx');
    const files = data.importers.map((i) => i.at.split(':')[0]).sort();
    assert.deepEqual(files, ['src/features/Confirm.tsx', 'src/features/Paid.tsx']);
    assert.ok(data.importers.some((i) => i.imports.includes('default as') === false));
  } finally {
    await p.dispose();
  }
});
