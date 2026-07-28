// Differential (§16): the `find_unused_props` VIEW — the repo-declared default and the `prop:`
// filter (t-997783). Same INDEPENDENT cold-`ts.Program` oracle as the sibling file
// (`helpers/unused-props.ts`), extended to re-derive each declared prop's DECLARATION FILE: that
// is the ground truth for "which props does the repo itself declare", and it is derived from
// absolute `fileName`s in the oracle's own program, not from the plugin's rel-path predicate.
//
// Discriminator (red→green): before the change the default view returned every declared member,
// so a shadcn-style wrapper buried its one own prop under the dependency's DOM/aria surface and
// tripped the output cap. The honesty arms are equally load-bearing: what the view omits is
// COUNTED, and a name missing from a CAPPED member set is `undetermined`, never "not declared".

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';
import { project, assertSpansValid } from '../helpers/project.ts';
import { PKG, TSCONFIG, data, oracle, unusedNames } from '../helpers/unused-props.ts';

// A shadcn-style wrapper declares its ONE own prop inside a type whose other ~290 members come from
// a dependency (`React.ComponentProps<'button'>`). The default view must answer about the props the
// repo declares — provable from each member's DECLARATION FILE (the heritage `inherited` flag is
// absent for an anonymous intersection, so it cannot carry this).

const DEP_WRAPPER = {
  'package.json': PKG,
  'tsconfig.json': TSCONFIG,
  'node_modules/dep/package.json': '{"name":"dep","version":"1.0.0","types":"index.d.ts"}',
  'node_modules/dep/index.d.ts':
    'export interface DepProps { depDead?: string; depUsed?: number }\n',
  'src/Widget.tsx':
    "import type { DepProps } from 'dep';\n" +
    'export const Widget = (props: DepProps & { ownDead?: boolean; ownUsed?: string }) =>\n' +
    '  <div>{props.ownUsed}</div>;\n',
  'src/App.tsx':
    "import { Widget } from './Widget';\n" +
    'export const App = () => <Widget depUsed={1} ownUsed="x"/>;\n',
};

test('default view = props the REPO declares; the dependency-declared ones are hidden AND counted', async () => {
  const p = await project(DEP_WRAPPER);
  try {
    const o = oracle(p.root, 'Widget');
    assert.deepEqual([...o.declared].sort(), ['depDead', 'depUsed', 'ownDead', 'ownUsed']);
    assert.deepEqual([...o.external].sort(), ['depDead', 'depUsed'], 'oracle: dep-declared props');
    const oracleRepoUnused = [...o.unused].filter((n) => !o.external.has(n)).sort();
    const oracleExternalUnused = [...o.unused].filter((n) => o.external.has(n));
    assert.deepEqual(oracleRepoUnused, ['ownDead']);
    assert.deepEqual(oracleExternalUnused, ['depDead']);

    const d = data(await p.op('find_unused_props', { component: 'Widget' }));
    assert.deepEqual([...unusedNames(d)].sort(), oracleRepoUnused, 'default == repo-declared dead');
    assert.equal(d['found'], 1);
    assert.equal(d['declared'], 4, 'the full declared count is still reported');
    assert.equal(d['hiddenExternal'], oracleExternalUnused.length, 'the omission is COUNTED');
    assert.ok(
      (d['notes'] as string[]).some((n) => n.includes('includeExternal')),
      'the omission names its own escape hatch — never a silent narrowing',
    );
    // Every row is repo-declared, so none carries the provenance marker.
    for (const u of d['unused'] as { external?: boolean }[]) assert.equal(u.external, undefined);
  } finally {
    await p.dispose();
  }
});

test('includeExternal:true restores the full set, each dependency-declared row marked external', async () => {
  const p = await project(DEP_WRAPPER);
  try {
    const o = oracle(p.root, 'Widget');
    const r = await p.op('find_unused_props', { component: 'Widget', includeExternal: true });
    const d = data(r);
    assert.deepEqual([...unusedNames(d)].sort(), [...o.unused].sort(), 'full set == oracle');
    assert.equal(d['hiddenExternal'], undefined, 'nothing hidden → no hidden channel at all');
    const marked = (d['unused'] as { name: string; external?: boolean }[])
      .filter((u) => u.external === true)
      .map((u) => u.name);
    assert.deepEqual(
      marked.sort(),
      [...o.unused].filter((n) => o.external.has(n)).sort(),
      'external marker == the oracle’s dependency-declared set',
    );
    assert.ok(assertSpansValid(p.root, r) > 0, 'proof spans still validated across both origins');
  } finally {
    await p.dispose();
  }
});

test('prop: answers about the named prop only — and overrides the repo-declared narrowing', async () => {
  const p = await project(DEP_WRAPPER);
  try {
    // A repo-declared dead prop: one row, no hidden channel (the filter, not the narrowing, chose).
    const own = data(await p.op('find_unused_props', { component: 'Widget', prop: 'ownDead' }));
    assert.deepEqual([...unusedNames(own)], ['ownDead']);
    assert.equal(own['found'], 1);
    assert.equal(own['hiddenExternal'], undefined);

    // A DEPENDENCY-declared prop the caller named explicitly: answered, and marked external.
    const dep = data(await p.op('find_unused_props', { component: 'Widget', prop: ['depDead'] }));
    assert.deepEqual([...unusedNames(dep)], ['depDead'], 'named prop is not narrowed away');
    assert.equal((dep['unused'] as { external?: boolean }[])[0]?.external, true);
  } finally {
    await p.dispose();
  }
});

test('prop: found:0 is disambiguated — passed-somewhere vs not-a-prop are never merged', async () => {
  const p = await project(DEP_WRAPPER);
  try {
    const o = oracle(p.root, 'Widget');
    const r = data(
      await p.op('find_unused_props', { component: 'Widget', prop: ['ownUsed', 'nope'] }),
    );
    assert.equal(r['found'], 0, 'neither is dead');
    assert.ok(o.passed.has('ownUsed'), 'oracle: ownUsed IS passed');
    assert.deepEqual(r['inUse'], ['ownUsed'], 'declared and passed → in use, not "no such prop"');
    assert.ok(!o.declared.has('nope'), 'oracle: nope is not declared');
    assert.deepEqual(r['notDeclared'], ['nope']);
    assert.equal(r['undetermined'], undefined, 'member set was not capped → a real absence claim');
  } finally {
    await p.dispose();
  }
});

test('a workspace package reached THROUGH a node_modules symlink stays repo-declared', async () => {
  // The damaging direction of the narrowing: a monorepo's OWN package is imported as
  // `@repo/ui`, i.e. via a `node_modules` symlink (the pnpm/yarn-workspaces layout). If the
  // declaration file were read as the symlink path, its props would be silently hidden. An
  // ACTUAL on-disk symlink is the oracle — not an assumption about what TS returns.
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'packages/ui/package.json': '{"name":"@repo/ui","version":"1.0.0","types":"props.ts"}',
    'packages/ui/props.ts': 'export interface UiProps { uiDead?: string; uiUsed?: number }\n',
    'src/Widget.tsx':
      "import type { UiProps } from '@repo/ui';\n" +
      'export const Widget = (props: UiProps & { ownDead?: boolean }) =>\n' +
      '  <div>{props.uiUsed}</div>;\n',
    'src/App.tsx':
      "import { Widget } from './Widget';\n" + 'export const App = () => <Widget uiUsed={1}/>;\n',
  });
  try {
    mkdirSync(path.join(p.root, 'node_modules', '@repo'), { recursive: true });
    symlinkSync(
      path.join(p.root, 'packages', 'ui'),
      path.join(p.root, 'node_modules', '@repo', 'ui'),
      'dir',
    );

    const o = oracle(p.root, 'Widget');
    assert.equal(o.external.size, 0, 'oracle: every prop is declared inside the repo');
    const d = data(await p.op('find_unused_props', { component: 'Widget' }));
    assert.deepEqual([...unusedNames(d)].sort(), ['ownDead', 'uiDead'], 'sibling prop not hidden');
    assert.equal(d['hiddenExternal'], undefined, 'nothing to hide — no false external');
  } finally {
    await p.dispose();
  }
});

test('narrowing does NOT touch the honesty channel: a spread still demotes the surviving rows', async () => {
  const p = await project({
    ...DEP_WRAPPER,
    'src/App.tsx':
      "import { Widget } from './Widget';\n" +
      'export const App = (rest: { ownUsed: string }) => <Widget depUsed={1} {...rest}/>;\n',
  });
  try {
    const d = data(await p.op('find_unused_props', { component: 'Widget' }));
    assert.equal(d['demoted'], true, 'the spread site demotes — computed over SITES, not members');
    const rows = d['unused'] as { name: string; confidence: string }[];
    assert.ok(rows.length > 0, 'the narrowed view still has rows to demote');
    for (const u of rows) assert.equal(u.confidence, 'partial', 'no false certain under narrowing');
    assert.ok(
      (d['notes'] as string[]).some((n) => n.includes('spread')),
      'the demote reason survives the narrowed view',
    );
    assert.ok((d['notes'] as string[]).some((n) => n.includes('includeExternal')));
  } finally {
    await p.dispose();
  }
});

test('prop: a name missing from a CAPPED member set is undetermined, never "not declared"', async () => {
  // 520 members > the ts seam's 500-member cap, so the declared set the plugin sees is a SLICE.
  const members = Array.from({ length: 520 }, (_, i) => `p${i}?: string`).join('; ');
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/Big.tsx': `export const Big = (props: { ${members} }) => <div>{props.p0}</div>;\n`,
  });
  try {
    const o = oracle(p.root, 'Big');
    assert.equal(o.declared.size, 520, 'oracle sees the whole set');
    assert.ok(!o.declared.has('zzz'), 'oracle: zzz is genuinely not a prop');

    const d = data(await p.op('find_unused_props', { component: 'Big', prop: ['zzz', 'p0'] }));
    // Even though the oracle proves zzz absent, codemaster did not SEE the whole set — claiming
    // "not declared" off a sliced page is the §3.4/§3.6 lie, whatever the true answer happens to be.
    assert.deepEqual(d['undetermined'], ['zzz']);
    assert.equal(d['notDeclared'], undefined, 'no proven-absence claim over an unseen set');
    assert.deepEqual([...unusedNames(d)], ['p0'], 'a member inside the slice still answers');
    assert.ok((d['notes'] as string[]).some((n) => n.includes('capped')));
  } finally {
    await p.dispose();
  }
});
