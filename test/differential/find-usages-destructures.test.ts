// Per-call-site return-shape triage (t-409060): `find_usages {..., destructures:true}` annotates each
// `call`-role usage with the shape it consumes the result as — the destructured props (`const
// {a,b}=fn()`), a `...rest` flag, a member access (`fn().x`), a discarded result (`fn();`), or `whole`
// (bound/passed as a value). So return-shape blast radius is triageable without opening every site.
//
// Oracle: a HAND-CURATED ground truth per site (§16 — find_usages is pinned against curated truth, not
// a cold findReferences, which would run the identical algorithm). Each fixture line maps to a known
// consumed shape; the op must reproduce it exactly, and the DEFAULT (flag off) must stay byte-stable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid, type TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Destructures = { props?: string[]; rest?: true; whole?: true };
type Usage = { span: { file: string; line: number }; destructures?: Destructures };

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/lib.ts': 'export function launchApp() {\n  return { browser: 1, context: 2, page: 3 };\n}\n',
  'src/sites.ts':
    "import { launchApp } from './lib';\n" + // 1
    'export const a = () => { const { browser, page } = launchApp(); return browser + page; };\n' + // 2 props
    'export const b = () => { const { context } = launchApp(); return context; };\n' + // 3 props
    'export const c = () => { const { browser, ...rest } = launchApp(); return rest; };\n' + // 4 rest
    'export const d = () => launchApp().context;\n' + // 5 member access
    'export const e = () => { launchApp(); };\n' + // 6 discarded
    'export const f = () => { const r = launchApp(); return r.browser; };\n' + // 7 whole (downstream member)
    'export const g = () => { const { page: p } = launchApp(); return p; };\n', // 8 renamed prop → page
};

function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const byLine = (us: Usage[]): Map<number, Destructures | undefined> =>
  new Map(us.map((u) => [u.span.line, u.destructures]));

test('destructures: each call site is annotated with the return-shape it consumes (hand-curated oracle)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const us = usagesOf(
      await p.op('find_usages', { name: 'launchApp', role: 'call', destructures: true }),
    );
    const m = byLine(us);
    assert.deepEqual(m.get(2), { props: ['browser', 'page'] }, 'plain destructure → its props');
    assert.deepEqual(m.get(3), { props: ['context'] }, 'single destructure');
    assert.deepEqual(
      m.get(4),
      { props: ['browser'], rest: true },
      '...rest is flagged, never dropped',
    );
    assert.deepEqual(m.get(5), { props: ['context'] }, 'member access fn().x → [x]');
    assert.deepEqual(m.get(6), { props: [] }, 'discarded fn(); → no props consumed');
    assert.deepEqual(
      m.get(7),
      { whole: true },
      'bound to a name → whole (downstream reads invisible)',
    );
    assert.deepEqual(
      m.get(8),
      { props: ['page'] },
      'renamed {page: p} reports the PROPERTY, not the local',
    );
  } finally {
    await p.dispose();
  }
});

const ADDED_SITE =
  'export const h = () => { const { context, page } = launchApp(); return context ?? page; };\n';
const stable = (us: Usage[]): string[] => us.map((u) => JSON.stringify(u)).sort();

test('destructures: cold == warm after adding a call site, spans valid (invariants 3 + 1)', async () => {
  // Warm: baseline query pins the freshness guard, then ADD a call site → op#2 must reindex
  // incrementally (not a disguised cold boot), and its per-site annotations must equal a cold boot
  // over the identical final tree. The destructures annotation is computed fresh per query, so a
  // divergence would be an incremental-state drift.
  const warmP: TestProject = await project(FILES);
  let warm: string[];
  try {
    await warmP.op('find_usages', { name: 'launchApp', role: 'call', destructures: true });
    warmP.write('src/sites.ts', FILES['src/sites.ts'] + ADDED_SITE);
    const op2 = await warmP.op('find_usages', {
      name: 'launchApp',
      role: 'call',
      destructures: true,
    });
    assert.ok('result' in op2 && op2.result.ok, JSON.stringify(op2));
    assert.ok(
      (op2.result.freshness?.reindexed ?? 0) >= 1,
      'op#2 must reindex incrementally — otherwise it is a disguised cold boot',
    );
    assertSpansValid(warmP.root, op2); // invariant 1 rides along
    warm = stable(usagesOf(op2));
  } finally {
    await warmP.dispose();
  }
  const coldP: TestProject = await project({
    ...FILES,
    'src/sites.ts': FILES['src/sites.ts'] + ADDED_SITE,
  });
  try {
    const cold = stable(
      usagesOf(
        await coldP.op('find_usages', { name: 'launchApp', role: 'call', destructures: true }),
      ),
    );
    assert.deepEqual(warm, cold, 'warm (post-add) destructures == cold boot');
  } finally {
    await coldP.dispose();
  }
});

test('destructures: the multi-target symbols[] path annotates too', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      symbols: ['launchApp'],
      role: 'call',
      destructures: true,
    });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const targets = (r.result.data as { targets?: { usages?: Usage[] }[] }).targets ?? [];
    const m = byLine(targets[0]?.usages ?? []);
    assert.deepEqual(
      m.get(2),
      { props: ['browser', 'page'] },
      'symbols[] path carries destructures',
    );
  } finally {
    await p.dispose();
  }
});

test('destructures: DEFAULT (flag off) carries no annotation — output byte-stable', async () => {
  const p: TestProject = await project(FILES);
  try {
    const us = usagesOf(await p.op('find_usages', { name: 'launchApp', role: 'call' }));
    assert.ok(us.length > 0, 'has call usages');
    assert.ok(
      us.every((u) => u.destructures === undefined),
      `no destructures field without the flag: ${JSON.stringify(us)}`,
    );
  } finally {
    await p.dispose();
  }
});

test('destructures: ignored under groupBy (a rollup row is not a per-site view) — disclosed, not silent', async () => {
  const p: TestProject = await project(FILES);
  try {
    const r = await p.op('find_usages', {
      name: 'launchApp',
      role: 'call',
      groupBy: 'enclosing',
      destructures: true,
    });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const data = r.result.data as { notes?: string[]; enclosers?: { destructures?: unknown }[] };
    assert.ok(
      (data.notes ?? []).some((n) => /destructures ignored/.test(n)),
      `the ignored flag is disclosed: ${JSON.stringify(data.notes)}`,
    );
    assert.ok(
      (data.enclosers ?? []).every((g) => g.destructures === undefined),
      'no per-site annotation leaks onto a grouped row',
    );
  } finally {
    await p.dispose();
  }
});
