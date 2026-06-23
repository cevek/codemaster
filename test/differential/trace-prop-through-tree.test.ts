// `trace_prop_through_tree` — oracle-backed (§16). The independent ground truth is HAND-CURATED from
// the assembled component tree below (the function-declarations precedent): a human reads the tree
// and writes the exact hop chain + per-hop honesty the op must produce. The op is then checked hop
// for hop, AND proof spans are validated against source.
//
// The tree (prop `userId` from <App>):
//   App({userId})  → <Profile userId={userId}/>   as-is   → Profile
//                  → <Header name={userId}/>       RENAME  → Header (leaf: renders {name} as text)
//                  → <Foo {...{userId}}/>          SPREAD  → Foo
//                  → <Bar other="x"/>              (no userId) → NO hop
//   Profile({userId}) → <Avatar userId={userId}/>  as-is   → Avatar
//   Avatar({userId})  → <img alt={userId}/>         RENAME  → <img> SINK (host element)
//
// Discriminators (red→green): a build that (a) DROPS the rename's `dynamic` flag, (b) DROPS the
// `{...spread}` hop, (c) labels the as-is forward `certain` instead of `partial`, (d) emits a Bar
// hop (false forward — `other="x"` carries no userId), or (e) stops at depth 1 (never reaching
// Avatar) — each fails a distinct assertion. propDeclared discriminates "no such prop" from "has it
// but doesn't forward it".

import test from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';
import type { JsonValue } from '../../src/core/json.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"jsx":"react-jsx","module":"preserve"}}';
const PKG = JSON.stringify({ dependencies: { react: '18' } });

const FILES: Record<string, string> = {
  'package.json': PKG,
  'tsconfig.json': TSCONFIG,
  'src/Avatar.tsx':
    'export const Avatar = ({ userId }: { userId: string }) => <img alt={userId} />;\n',
  'src/Profile.tsx':
    "import { Avatar } from './Avatar';\n" +
    'export const Profile = ({ userId }: { userId: string }) => <Avatar userId={userId} />;\n',
  'src/Header.tsx': 'export const Header = ({ name }: { name: string }) => <h1>{name}</h1>;\n',
  'src/Foo.tsx': 'export const Foo = ({ userId }: { userId: string }) => <div>{userId}</div>;\n',
  'src/Bar.tsx': 'export const Bar = ({ other }: { other: string }) => <div>{other}</div>;\n',
  'src/App.tsx':
    "import { Profile } from './Profile';\n" +
    "import { Header } from './Header';\n" +
    "import { Foo } from './Foo';\n" +
    "import { Bar } from './Bar';\n" +
    'export const App = ({ userId }: { userId: string }) => (\n' +
    '  <div>\n' +
    '    <Profile userId={userId} />\n' +
    '    <Header name={userId} />\n' +
    '    <Foo {...{ userId }} />\n' +
    '    <Bar other="x" />\n' +
    '  </div>\n' +
    ');\n',
};

type Hop = {
  from: { label: string };
  to: { label: string };
  relation: string;
  confidence: string;
  provenance: { kind: string };
  note?: string;
};

function data(r: OpResult): Record<string, JsonValue> {
  if ('error' in r) throw new Error(`dispatch error: ${r.error.message}`);
  assert.ok(r.result.ok, 'expected ok result');
  return r.result.data as Record<string, JsonValue>;
}

function findHop(hops: Hop[], from: string, to: string): Hop | undefined {
  return hops.find((h) => h.from.label === from && h.to.label === to);
}

test('trace_prop_through_tree: userId from <App> — chain + per-hop honesty match hand-curated oracle', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('trace_prop_through_tree', { name: 'App', prop: 'userId' });
    const d = data(r);
    const hops = d['hops'] as unknown as Hop[];

    assert.equal(d['found'], 1, 'App resolved as a component');
    assert.equal(d['propDeclared'], true, 'userId IS a declared prop of App');

    // (1) as-is forward → partial, syntactic (NOT certain — a same-named local could shadow).
    const toProfile = findHop(hops, 'App', 'Profile');
    assert.ok(toProfile, 'App → Profile hop present');
    assert.equal(toProfile?.relation, 'passes');
    assert.equal(toProfile?.confidence, 'partial', 'as-is is partial, never certain');
    assert.equal(toProfile?.provenance.kind, 'syntactic');

    // (2) depth chain: Profile → Avatar (as-is), Avatar → <img> sink (rename to host attr).
    const toAvatar = findHop(hops, 'Profile', 'Avatar');
    assert.ok(toAvatar, 'depth>1: Profile → Avatar reached (did not stop at depth 1)');
    assert.equal(toAvatar?.confidence, 'partial');
    const toImg = findHop(hops, 'Avatar', '<img>');
    assert.ok(toImg, 'Avatar → <img> host sink present');
    assert.equal(toImg?.relation, 'renames', 'alt={userId} renames userId→alt');
    assert.equal(toImg?.confidence, 'dynamic');

    // (3) rename → dynamic, flagged (NOT dropped, NOT certain). The #1 honesty point.
    const toHeader = findHop(hops, 'App', 'Header');
    assert.ok(toHeader, 'App → Header rename hop present (a textual same-name walk would miss it)');
    assert.equal(toHeader?.relation, 'renames');
    assert.equal(toHeader?.confidence, 'dynamic');
    assert.match(String(toHeader?.note), /renamed userId→name/);

    // (4) spread → dynamic, flagged.
    const toFoo = findHop(hops, 'App', 'Foo');
    assert.ok(toFoo, 'App → Foo spread hop present');
    assert.equal(toFoo?.relation, 'spreads');
    assert.equal(toFoo?.confidence, 'dynamic');

    // (5) negative: Bar receives other="x", NOT userId → no hop (no false forward).
    assert.equal(findHop(hops, 'App', 'Bar'), undefined, 'no false forward to Bar');

    // Headline counts: 4 distinct downstream COMPONENTS (Profile, Avatar, Header, Foo); the <img>
    // sink is not a component. 3 dynamic hops (Header rename, Foo spread, img rename).
    assert.equal(d['reaches'], 4, 'distinct downstream components');
    assert.equal(d['dynamicHops'], 3, 'rename + spread + sink-rename flagged dynamic');

    assert.ok(assertSpansValid(p.root, r) > 0, 'hop proof spans validated against source');
  } finally {
    await p.dispose();
  }
});

test('trace_prop_through_tree: an undeclared prop is honestly flagged, not conflated with no-forward', async () => {
  const p = await project(FILES);
  try {
    const r = await p.op('trace_prop_through_tree', { name: 'App', prop: 'nope' });
    const d = data(r);
    const hops = d['hops'] as unknown as Hop[];
    assert.equal(d['found'], 1);
    assert.equal(d['propDeclared'], false, "'nope' is not a declared prop of App");
    // No EXPLICIT forward of a nonexistent prop (no Profile/Header hop)...
    assert.equal(findHop(hops, 'App', 'Profile'), undefined, 'no explicit forward of nope');
    assert.equal(findHop(hops, 'App', 'Header'), undefined);
    // ...but a `{...spread}` could honestly carry it — that hop IS present, flagged dynamic.
    const toFoo = findHop(hops, 'App', 'Foo');
    assert.ok(toFoo, 'spread MAY carry nope — honest dynamic hop');
    assert.equal(toFoo?.confidence, 'dynamic');
    assert.ok(
      (d['notes'] as string[]).some((n) => n.includes('nope')),
      'a note names the undeclared prop',
    );
  } finally {
    await p.dispose();
  }
});
