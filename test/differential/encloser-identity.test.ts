// Encloser identity & rollup fidelity (spec-encloser-identity-fidelity). Every rollup
// handle must be CHAINABLE, CORRECTLY-KINDED, and PROOF-CARRYING at the reference level.
// The oracle is HAND-CURATED here (the fixture is input; the ground truth is written in the
// assertions, never read back from the tool), and re-resolution is proven END-TO-END — a
// minted encloser id is fed back into find_definition / source / rename, the exact chain an
// agent runs. A dead handle would resolve `gone`; these tests fail if it does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, assertSpansValid } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Span = { file: string; line: number; col: number; text: string };
type Encloser = {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  col: number;
  roles: string;
  exported: boolean;
  site?: Span;
};

function enclosersOf(r: OpResult): Encloser[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { enclosers?: Encloser[] }).enclosers ?? [];
}

// ── Bug 1: a class-member encloser mints a CHAINABLE id (the dead handle, primary) ──────

test('class-member encloser id re-resolves via find_definition/source/rename — not `gone`', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': 'export const useX = (): number => 1;\n',
    'src/c.ts':
      "import { useX } from './x';\n" +
      'export class Widget {\n' +
      '  render(): number {\n' +
      '    return useX();\n' + // the reference rolls up to Widget.render
      '  }\n' +
      '}\n',
  });
  try {
    const enclosers = enclosersOf(
      await p.op('find_usages', { name: 'useX', groupBy: 'enclosing' }),
    );
    const member = enclosers.find((e) => e.name === 'Widget.render');
    if (member === undefined)
      throw new Error(`no Widget.render encloser: ${JSON.stringify(enclosers)}`);

    // Correctly kinded, and the DISPLAY name is qualified…
    assert.equal(member.kind, 'method');
    assert.equal(member.name, 'Widget.render');
    // …but the id is minted on the BARE token (`render@…`), never the qualified `Widget.render`
    // (which would resolve `gone` — §6). This is the heart of bug 1.
    assert.ok(
      member.id.includes('render@src/c.ts:3:'),
      `id anchors on the bare member token: ${member.id}`,
    );
    assert.ok(!member.id.includes('Widget.render@'), 'the qualified display name is NEVER the id');

    // The whole point of the rollup: the handle CHAINS. find_definition resolves it to the
    // method decl (not gone), source returns its body, rename finds it.
    const def = await p.op('find_definition', { symbolId: member.id });
    assert.ok(
      'result' in def && def.result.ok,
      `def must resolve, not gone: ${JSON.stringify(def)}`,
    );
    const defs = (def.result.data as { definitions?: { name: string }[] }).definitions ?? [];
    assert.ok(
      defs.some((d) => d.name === 'render'),
      'encloser id resolves to the `render` method',
    );

    const src = await p.op('source', { targets: [{ symbolId: member.id }] });
    assert.ok('result' in src && src.result.ok, JSON.stringify(src));
    const sources =
      (src.result.data as { sources?: { name: string; decl: { text: string } }[] }).sources ?? [];
    assert.ok(
      sources.some((s) => s.decl.text.includes('return useX();')),
      'source returns the method body',
    );

    // rename via a full request so `apply` would ride at top level; dry-run (default) must
    // produce a real diff — a `gone` handle yields no edit.
    const [ren] = await p.request([
      { name: 'rename_symbol', args: { symbolId: member.id, newName: 'renderX' } },
    ]);
    assert.ok(ren !== undefined && 'result' in ren && ren.result.ok, JSON.stringify(ren));
    const env = ren.result.data as { diff: string; touched: string[] };
    assert.ok(
      env.touched.includes('src/c.ts') && env.diff.includes('renderX'),
      'rename finds & edits the method',
    );
  } finally {
    await p.dispose();
  }
});

test('a function-valued class FIELD (arrow handler) rolls up to the member, not the class', async () => {
  // Bug 1's scope is "class-method/property encloser". A React arrow-bound field
  // (`handler = () => useX()`) must roll up to `Widget.handler` (a re-resolvable member), not
  // coarsely to the class `Widget`. Mirrors the MethodDeclaration case.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': 'export const useX = (): number => 1;\n',
    'src/c.ts':
      "import { useX } from './x';\n" +
      'export class Widget {\n' +
      '  handler = (): number => useX();\n' + // function-valued class field, ref on line 3
      '}\n',
  });
  try {
    const enclosers = enclosersOf(
      await p.op('find_usages', { name: 'useX', groupBy: 'enclosing' }),
    );
    const member = enclosers.find((e) => e.name === 'Widget.handler');
    if (member === undefined)
      throw new Error(`useX did not roll up to Widget.handler: ${JSON.stringify(enclosers)}`);
    assert.equal(member.kind, 'method', 'a function-valued field is a member encloser');
    assert.ok(
      member.id.includes('handler@src/c.ts:3:'),
      `id anchors on the bare field token: ${member.id}`,
    );
    assert.ok(!member.id.includes('Widget.handler@'), 'qualified display name is never the id');
    assert.ok(
      !enclosers.some((e) => e.name === 'Widget'),
      'the ref did NOT roll up coarsely to the class',
    );

    // Chains: the member id re-resolves (not gone).
    const def = await p.op('find_definition', { symbolId: member.id });
    assert.ok('result' in def && def.result.ok, JSON.stringify(def));
  } finally {
    await p.dispose();
  }
});

// ── Bug 2: a HOC / tagged-template-wrapped top-level binding is kinded `function` ────────

test('memo/forwardRef/styled binding is kinded `function` and survives a kind:function filter', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
    'src/x.ts': 'export const useX = (): number => 1;\n',
    'src/c.tsx':
      "import { useX } from './x';\n" +
      'declare const memo: <T>(c: T) => T;\n' +
      'declare const forwardRef: <T>(c: T) => T;\n' +
      'declare const styled: { div: (s: TemplateStringsArray, ...e: unknown[]) => () => number };\n' +
      'export const Memoized = memo(() => useX());\n' + // call wrapping an arrow → function
      'export const Fwd = forwardRef((): number => useX());\n' + // call wrapping an arrow → function
      'export const Boxed = styled.div`${useX()}`;\n' + // tagged template → function
      'export const plain = wrap(useX);\n' + // call, NO arrow arg → stays a value binding
      'declare function wrap(f: unknown): number;\n',
  });
  try {
    const enclosers = enclosersOf(
      await p.op('find_usages', { name: 'useX', groupBy: 'enclosing' }),
    );
    const byName = new Map(enclosers.map((e) => [e.name, e]));

    for (const name of ['Memoized', 'Fwd', 'Boxed']) {
      const e = byName.get(name);
      if (e === undefined) throw new Error(`no ${name} encloser: ${JSON.stringify(enclosers)}`);
      assert.equal(e.kind, 'function', `${name} is a renderable binding → kind function`);
    }
    // The contrast that keeps the trigger honest: a call with NO callback argument stays a
    // value binding (kind `const`), so the broad peek did not swallow ordinary value bindings.
    assert.equal(byName.get('plain')?.kind, 'const', 'wrap(useX) — no arrow arg — stays const');

    // The actual under-report bug 2 closes: a kind:'function' VIEW now KEEPS the HOC bindings.
    const filtered = enclosersOf(
      await p.op('find_usages', {
        name: 'useX',
        groupBy: 'enclosing',
        filter: { kind: 'function' },
      }),
    );
    const kept = new Set(filtered.map((e) => e.name));
    assert.ok(
      ['Memoized', 'Fwd', 'Boxed'].every((n) => kept.has(n)),
      'HOC bindings survive kind:function',
    );
    assert.ok(!kept.has('plain'), 'the value binding is correctly excluded by kind:function');
  } finally {
    await p.dispose();
  }
});

test('a function-valued NESTED LOCAL binding does NOT divert a ref off its enclosing function', async () => {
  // The widened `isFunctionValued` must stay SCOPE-GATED: a ref inside a nested-local
  // callback (`const cb = wrapCb(() => dep())` inside `serve`) belongs to `serve`, the
  // robust re-resolvable encloser — NOT the fragile local `cb`. Diverting it to the local
  // would relocate the exact harm bug 2 fixes: a `kind:'function'` view would HIDE `serve`
  // and SHOW the meaningless local. (Regression caught by the Bug 2/3 reviewer.)
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts':
      'export const dep = (): number => 1;\n' +
      'export const wrapCb = (f: () => number): number => f();\n',
    'src/s.ts':
      "import { dep, wrapCb } from './x';\n" +
      'export function serve(): number {\n' +
      '  const cb = wrapCb(() => dep());\n' + // nested local, function-valued (call w/ callback)
      '  return cb;\n' +
      '}\n',
  });
  try {
    const enclosers = enclosersOf(await p.op('find_usages', { name: 'dep', groupBy: 'enclosing' }));
    const names = new Set(enclosers.map((e) => e.name));
    assert.ok(names.has('serve'), '`dep` rolls up to the enclosing function `serve`');
    assert.ok(!names.has('cb'), 'the ref did NOT divert to the nested-local binding `cb`');
    const serve = enclosers.find((e) => e.name === 'serve');
    assert.equal(serve?.kind, 'function');
  } finally {
    await p.dispose();
  }
});

// ── Bug 3: a namespace-nested binding is an encloser → impact expands through it ─────────

type ImpactData = {
  summary: { complete: boolean };
  dependents?: Record<string, { id: string; name: string }[]>;
};

test('namespace-nested const is its own re-resolvable encloser; impact expands through it', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/base.ts': 'export const base = (): number => 1;\n',
    'src/n.ts':
      "import { base } from './base';\n" +
      'export namespace N {\n' +
      '  export const helper: number = base();\n' + // namespace-nested VALUE binding (not a function)
      '}\n',
    'src/use.ts': "import { N } from './n';\nexport const top = (): number => N.helper;\n",
  });
  try {
    // find_usages: the ref to `base` rolls up to the namespace-nested binding `helper`
    // (re-resolvable, kind `const` — the ModuleBlock-boundary fix), NOT the `n.ts` module node
    // it dead-ended at before. (The `(top-level base.ts)` node is base's OWN decl — legitimate.)
    const enclosers = enclosersOf(
      await p.op('find_usages', { name: 'base', groupBy: 'enclosing' }),
    );
    const helper = enclosers.find((e) => e.name === 'helper');
    if (helper === undefined)
      throw new Error(`base did not roll up to helper: ${JSON.stringify(enclosers)}`);
    assert.equal(helper.kind, 'const', 'a namespace-nested value binding is a `const` encloser');
    assert.ok(
      helper.id.includes('helper@src/n.ts:3:'),
      `re-resolvable namespace-member id: ${helper.id}`,
    );
    assert.ok(
      !enclosers.some((e) => e.name === '(top-level n.ts)'),
      'the base ref did NOT dead-end at the n.ts module node',
    );

    // impact: the closure must EXPAND THROUGH helper to top (depth 2) — the dead-end is closed.
    const ir = await p.op('impact', { name: 'base', depth: 3 });
    assert.ok('result' in ir && ir.result.ok, JSON.stringify(ir));
    const d = ir.result.data as ImpactData;
    const deps: { name: string; depth: number }[] = [];
    for (const [depth, rows] of Object.entries(d.dependents ?? {})) {
      for (const row of rows) deps.push({ name: row.name, depth: Number(depth) });
    }
    assert.deepEqual(
      deps.map((x) => `${x.name}@${x.depth}`).sort(),
      ['helper@1', 'top@2'],
      'closure expands base → helper → top (no spurious module dead-end)',
    );
  } finally {
    await p.dispose();
  }
});

// ── Bug 4: grouped find_usages is proof-carrying at the reference level (the `site` span) ─

test('grouped find_usages emits a reference `site` span equal to live source, distinct from the encloser name', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/x.ts': 'export const useX = (): number => 1;\n',
    'src/w.ts':
      "import { useX } from './x';\n" +
      'export function widget(): number {\n' +
      '  const a = useX();\n' + // the reference is on line 3, NOT the `widget` name token (line 2)
      '  return a;\n' +
      '}\n',
  });
  try {
    const r = await p.op('find_usages', { name: 'useX', groupBy: 'enclosing' });
    const enclosers = enclosersOf(r);
    const w = enclosers.find((e) => e.name === 'widget');
    if (w === undefined) throw new Error('no widget encloser');

    // The site is surfaced (no longer stripped) and is a real proof span…
    assert.ok(w.site !== undefined, 'the representative reference site is surfaced');
    assert.equal(w.site.text, 'useX', 'site is the verbatim reference token');
    // …§16 inv.1: every emitted span text equals the live source.
    const validated = assertSpansValid(p.root, r);
    assert.ok(validated > 0, 'at least one proof span was validated (no hollow green)');

    // Distinct from the encloser NAME token: the ref is on line 3, the `widget` name on line 2.
    assert.equal(w.line, 2, 'encloser name token line');
    assert.equal(w.site.line, 3, 'reference site line — a DIFFERENT location');
  } finally {
    await p.dispose();
  }
});
