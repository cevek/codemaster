// Differential (§16): `find_unused_props` against an INDEPENDENT cold-`ts.Program` oracle written
// here — NOT the plugin's own seams (that would be circular). The oracle re-derives, with its own
// checker, a component's DECLARED props (apparent-type properties of the first parameter) and its
// PASSED props (JSX attributes at every site whose tag symbol resolves — alias-aware — to the
// component). declared − passed = the dead set. Proof spans are validated against source.
//
// Discriminators (red→green): (1) an ALIASED `<B size/>` where `B` is `import { Button as B }` —
// a textual `<Button` scan misses it and would falsely report `size` dead; (2) a `memo(C)` wrapper
// used as `<D .../>` — the props pass through an alias codemaster can't read, so EVERY verdict must
// demote to `partial`, never a false `certain`-dead (the #1 risk).

import test from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import { PKG, TSCONFIG, data, oracle, unusedNames } from '../helpers/unused-props.ts';

test('aliased <B size/> pass: declared − passed matches cold oracle; certain (grep would miss the alias)', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/Button.tsx':
      'export const Button = (props: { size: string; color?: string; dead?: number }) =>\n' +
      '  <button>{props.size}</button>;\n',
    'src/App.tsx':
      "import { Button as B } from './Button';\n" +
      'export const App = () => <B size="lg" color="red"/>;\n',
  });
  try {
    const r = await p.op('find_unused_props', { component: 'Button' });
    const d = data(r);
    const o = oracle(p.root, 'Button');

    assert.deepEqual([...o.declared].sort(), ['color', 'dead', 'size']);
    assert.deepEqual([...o.passed].sort(), ['color', 'size'], 'alias <B/> passes size+color');
    assert.deepEqual([...unusedNames(d)].sort(), [...o.unused].sort(), 'warm unused == oracle');
    assert.deepEqual([...unusedNames(d)], ['dead']);
    assert.equal(d['demoted'], false, 'all sites readable, no spread → certain');
    const dead = (d['unused'] as { name: string; confidence: string }[])[0];
    assert.equal(dead?.confidence, 'certain');
    assert.ok(assertSpansValid(p.root, r) > 0, 'declaration proof spans validated');
  } finally {
    await p.dispose();
  }
});

test('memo(C) wrapper used as <D/>: verdicts demote to partial — never a false certain-dead', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/C.tsx':
      'const memo = <T,>(f: T): T => f;\n' +
      'export const C = (props: { x: string; y: number }) => <span>{props.x}</span>;\n' +
      'export const D = memo(C);\n',
    'src/Use.tsx': 'import { D } from \'./C\';\nexport const Use = () => <D x="1"/>;\n',
  });
  try {
    const r = await p.op('find_unused_props', { component: 'C' });
    const d = data(r);
    // The oracle sees no DIRECT <C/> site (props flow through D=memo(C)), so its name set is {x,y}.
    const o = oracle(p.root, 'C');
    assert.deepEqual([...unusedNames(d)].sort(), [...o.unused].sort());
    assert.deepEqual([...unusedNames(d)].sort(), ['x', 'y']);
    // The honesty invariant: the memo(C) value reference is opaque → the WHOLE set is partial.
    assert.equal(d['demoted'], true, 'opaque (memo) reference demotes the set');
    for (const u of d['unused'] as { confidence: string }[]) {
      assert.equal(u.confidence, 'partial', 'no false certain-dead under an opaque reference');
    }
    assert.ok(
      (d['notes'] as string[]).some((n) => n.includes('memo') || n.includes('unreadabl')),
      'demote reason names the opaque reference',
    );
  } finally {
    await p.dispose();
  }
});

test('spread <Button {...rest}/> demotes; extends/intersection props are flattened into declared', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/Box.tsx':
      'interface Base { id: string }\n' +
      'type BoxProps = Base & { tone?: string; ghost?: boolean };\n' +
      'export const Box = (props: BoxProps) => <div id={props.id}/>;\n',
    'src/App.tsx':
      "import { Box } from './Box';\n" +
      'export const App = (rest: { tone: string }) => <Box id="a" {...rest}/>;\n',
  });
  try {
    const r = await p.op('find_unused_props', { component: 'Box' });
    const d = data(r);
    const o = oracle(p.root, 'Box');
    // Intersection + extends flattened: id (from Base), tone, ghost all declared.
    assert.deepEqual([...o.declared].sort(), ['ghost', 'id', 'tone'], 'flattened declared set');
    // `id` passed; tone/ghost not — but the spread makes them unprovable.
    assert.deepEqual([...unusedNames(d)].sort(), ['ghost', 'tone']);
    assert.equal(d['demoted'], true, 'a {...spread} site demotes the verdicts');
    for (const u of d['unused'] as { confidence: string }[]) {
      assert.equal(u.confidence, 'partial');
    }
  } finally {
    await p.dispose();
  }
});

test('JSX content <C>body</C> passes the children prop — not a false certain-dead', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    // `children` is passed as CONTENT (not a `children={…}` attribute); `title` is passed; `dead`
    // never. A self-closing-only reading would call `children` dead — the F1 regression.
    'src/Panel.tsx':
      'export const Panel = (props: { title: string; children?: unknown; dead?: number }) =>\n' +
      '  <section>{props.children as never}</section>;\n',
    'src/App.tsx':
      "import { Panel } from './Panel';\n" +
      'export const App = () => <Panel title="t"><span>hi</span></Panel>;\n',
  });
  try {
    const r = await p.op('find_unused_props', { component: 'Panel' });
    const d = data(r);
    const o = oracle(p.root, 'Panel');
    assert.ok(o.passed.has('children'), 'oracle: content passes children');
    assert.deepEqual([...unusedNames(d)].sort(), [...o.unused].sort(), 'warm == oracle');
    assert.deepEqual([...unusedNames(d)], ['dead'], 'children + title used; only dead unused');
    assert.equal(d['demoted'], false);
  } finally {
    await p.dispose();
  }
});

test('honest non-result: unknown component reports found:0 with a note, not an empty success', async () => {
  const p = await project({
    'package.json': PKG,
    'tsconfig.json': TSCONFIG,
    'src/Button.tsx': 'export const Button = (p: { a: string }) => <button>{p.a}</button>;\n',
  });
  try {
    const r = await p.op('find_unused_props', { component: 'Nope' });
    const d = data(r);
    assert.equal(d['found'], 0);
    assert.ok(
      (d['notes'] as string[]).some((n) => n.includes('Nope')),
      'note names the component',
    );
  } finally {
    await p.dispose();
  }
});
