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

// t-135997: a RESOLVED module nothing imports (honest 0) must read DISTINCTLY from an UNRESOLVED
// specifier (a typo'd/out-of-project arg). Oracle by construction: `src/ui/orphan.tsx` is a real
// file no other file imports (resolved-0); 'NotARealPathXYZ' resolves to nothing (unresolved). A
// hermetic fixture has no undiscovered-config floor, so the two answers differ ONLY on resolution.
const RESOLUTION_FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/keep.ts': 'export const keep = 1;\n',
  'src/ui/orphan.ts': 'export const orphan = 1; // real file, nothing imports it\n',
};

test('importers_of distinguishes a resolved-0 module from an unresolved specifier (§3.6)', async () => {
  const p = await project(RESOLUTION_FILES);
  try {
    const resolved0 = await p.op('importers_of', { module: 'src/ui/orphan.ts' });
    const unresolved = await p.op('importers_of', { module: 'NotARealPathXYZ' });
    assert.ok('result' in resolved0 && resolved0.result.ok, JSON.stringify(resolved0));
    assert.ok('result' in unresolved && unresolved.result.ok, JSON.stringify(unresolved));
    const rd = resolved0.result.data as { resolved: boolean; note: string; importers: unknown[] };
    const ud = unresolved.result.data as { resolved: boolean; note: string; importers: unknown[] };

    // Both are genuinely 0 importers…
    assert.equal(rd.importers.length, 0);
    assert.equal(ud.importers.length, 0);
    // …but the resolution verdict is the discriminator (RED before the fix: neither carried it,
    // and both notes said the same "no importers found — check the specifier").
    assert.equal(rd.resolved, true, 'a real file resolves');
    assert.equal(ud.resolved, false, 'a typo does not resolve');
    assert.notEqual(rd.resolved, ud.resolved);
    // The note honestly names the resolution state — not the same string for both.
    assert.match(rd.note, /resolved: src\/ui\/orphan\.ts.*0 importers/);
    assert.match(ud.note, /unresolved: NotARealPathXYZ/);
    assert.notEqual(rd.note, ud.note);
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
