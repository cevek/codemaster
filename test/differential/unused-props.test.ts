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
import {
  PKG,
  TSCONFIG,
  data,
  declarationFiles,
  failure,
  oracle,
  unusedNames,
} from '../helpers/unused-props.ts';

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

// t-585566 — a failed component lookup must not be shaped like an established absence. On the
// SUCCESS path `found` counts UNUSED props, so `ok{found:0}` for a name that never resolved made
// "no such component" and "this component has no dead props" byte-identical to a `format:'json'` /
// sql consumer, whose only channel is the number. The discriminator asserted here is `result.ok`,
// which is machine-readable; the note that used to carry the difference is prose the `0` never had.
//
// The oracle is an INDEPENDENT cold `ts.Program` (`declarationFiles`), and it is deliberately NOT
// the props oracle: that one reports an absent component and a propless one identically — exactly
// the conflation under test. One fixture, three names, three ground truths: `Nope` is declared
// NOWHERE (the lookup cannot succeed), `Clean` is declared once with every prop passed (an
// established zero), `Dup` is declared TWICE (ambiguous — also unresolvable).
const RESOLVE_FIXTURE = {
  'package.json': PKG,
  'tsconfig.json': TSCONFIG,
  'src/Clean.tsx': 'export const Clean = (p: { a: string }) => <button>{p.a}</button>;\n',
  'src/App.tsx': 'import { Clean } from \'./Clean\';\nexport const App = () => <Clean a="x"/>;\n',
  'src/Dup1.tsx': 'export const Dup = (p: { z: string }) => <i>{p.z}</i>;\n',
  'src/Dup2.tsx': 'export const Dup = (p: { z: string }) => <b>{p.z}</b>;\n',
};

test('a failed component lookup FAILS — it is not an ok{found:0} (the established zero keeps that shape)', async () => {
  const p = await project(RESOLVE_FIXTURE);
  try {
    // Ground truth first, so the two expectations rest on the repo's construction, not on
    // codemaster answering about itself.
    assert.deepEqual(
      declarationFiles(p.root, 'Nope'),
      [],
      'oracle: nothing named Nope is declared',
    );
    const o = oracle(p.root, 'Clean');
    assert.deepEqual([...o.declared], ['a'], 'oracle: Clean declares one prop');
    assert.deepEqual([...o.unused], [], 'oracle: every declared prop is passed — an HONEST zero');

    const miss = await p.op('find_unused_props', { component: 'Nope' });
    const clean = await p.op('find_unused_props', { component: 'Clean' });

    // The load-bearing assert: the two answers differ in a field a machine reads.
    assert.ok('result' in miss && 'result' in clean);
    assert.notEqual(
      miss.result.ok,
      clean.result.ok,
      'a lookup that failed and a component with no dead props must NOT share a shape',
    );

    const f = failure(miss);
    assert.equal(f.tool, 'react', 'the react convention resolve is the oracle that fell short');
    assert.match(f.message, /Nope/, 'the resolver message is preserved verbatim');
    assert.ok(!('data' in miss.result), 'a failed establishment carries no data to misread');

    // …and the established zero is UNCHANGED — over-correcting this into a failure/partial would be
    // the same lie inverted (§3.6): the walk finished and really found nothing dead.
    const d = data(clean);
    assert.equal(d['found'], 0, 'a resolved component with no dead props still answers found:0');
    assert.equal(d['declared'], 1);
  } finally {
    await p.dispose();
  }
});

test('an AMBIGUOUS component name fails too — one unresolved target, not a zero over an arbitrary pick', async () => {
  const p = await project(RESOLVE_FIXTURE);
  try {
    assert.equal(declarationFiles(p.root, 'Dup').length, 2, 'oracle: Dup is declared twice');
    const r = await p.op('find_unused_props', { component: 'Dup' });
    const f = failure(r);
    assert.equal(f.tool, 'react');
    assert.match(f.message, /ambiguous/i);
    assert.match(f.message, /Dup1\.tsx/, 'the candidate list survives into the failure');
    assert.match(f.message, /file:/, 'and so does the remedy that resolves it');

    // Disambiguated, the same name answers normally — proof the failure is about the ADDRESSING,
    // not a blanket refusal of the name.
    const d = data(await p.op('find_unused_props', { component: 'Dup', file: 'src/Dup1.tsx' }));
    assert.equal(d['component'], 'Dup');
    assert.deepEqual([...unusedNames(d)], ['z'], 'z is never passed anywhere');
  } finally {
    await p.dispose();
  }
});

// The contract change reaches the sql/batch surface too, and that is where it does the most good: a
// producer returning `ok:false` FAILS the SELECT (a join over a missing table would lie), whereas the
// old empty-table `ok` let a typo'd component slip silently into an anti-join as "nothing found".
// Pinned here because a shape change in a JOIN producer is a contract change for every consumer.
test('sql: a typo in `component` fails the SELECT and NAMES the producer — never a silent empty table', async () => {
  const p = await project(RESOLVE_FIXTURE);
  try {
    const results = await p.request(
      [{ name: 'find_unused_props', args: { component: 'Nope' }, as: 'dead' }],
      {
        sql: 'SELECT COUNT(*) AS n FROM dead',
        return: 'all',
      },
    );
    const sql = results[results.length - 1];
    assert.ok(sql !== undefined && 'result' in sql && !sql.result.ok, JSON.stringify(results));
    const msg = sql.result.failure.message;
    assert.match(msg, /find_unused_props/, 'the failed producer is named, not "a producer"');
    assert.match(msg, /as dead/, 'by its alias, so a multi-producer join says WHICH');
    assert.match(msg, /Nope/, 'and carries the underlying cause, no re-run needed');
  } finally {
    await p.dispose();
  }
});
