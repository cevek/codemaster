// §16 invariant 5 made concrete on the traps `find_usages` beats grep on — and the §16
// claim "`find_usages ⊇ grep` does NOT hold" made into assertions in BOTH directions:
//   · alias / barrel / type-only / cross-file → find_usages INCLUDES a semantic site that
//     a word-boundary grep MISSES (the aliased `<B/>` under `import {Button as B}`).
//   · same-named symbols in different scopes → find_usages EXCLUDES the unrelated same-name
//     site that grep INCLUDES (symbol identity, not text — the thing grep cannot do).
//
// The independent oracle is the HAND-CURATED expected site per trap (the fixture is input;
// the ground truth is written here, not read back from a second LS — comparing to a cold
// `findReferences` would be the circular check §16 explicitly forbids). ripgrep is the
// DISTINCTNESS cross-check only, honest-skipped when absent, so every find_usages-side
// assertion stands on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { rgSites } from '../helpers/ripgrep.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = {
  span: { file: string; line: number; col: number };
  role: string;
  confidence: string;
};

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}',
  'src/Button.tsx':
    'export interface Props { size: string }\n' +
    'export const Button = (p: Props) => <button>{p.size}</button>;\n',
  'src/App.tsx':
    "import { Button as B } from './Button';\n" + // alias import
    "import type { Props as P } from './Button';\n" + // type-only, aliased
    'export const make = (p: P): string => p.size;\n' + // `: P` — type usage at line 3
    'export const App = () => <B size="lg" />;\n', // `<B/>` — jsx usage at line 4
  'src/index.ts': "export { Button } from './Button';\n", // barrel re-export
  // Two unrelated symbols that share the name `dup` — the precision trap.
  'src/scopeA.ts': 'const dup = 1;\nexport const useA = (): number => dup + 1;\n',
  'src/scopeB.ts': 'const dup = 2;\nexport const useB = (): number => dup + 2;\n',
};

function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const has = (u: Usage[], file: string, line: number, role?: string): boolean =>
  u.some(
    (x) => x.span.file === file && x.span.line === line && (role === undefined || x.role === role),
  );
// The EXACT semantic set as `file:line:role` strings, sorted — for set-equality assertions
// (inclusion alone passes a spurious-extra or dropped site, §3 completeness/precision).
const projset = (u: Usage[]): string[] =>
  u.map((x) => `${x.span.file}:${x.span.line}:${x.role}`).sort();

test('alias + barrel + cross-file: find_usages includes sites a word-grep misses', async () => {
  const p: TestProject = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    // The aliased JSX usage `<B/>` (App.tsx:4) — resolved through `Button as B`, the
    // canonical thing grep cannot follow. And the barrel re-export (index.ts:1).
    assert.ok(has(u, 'src/App.tsx', 4, 'jsx'), 'aliased <B/> usage found semantically');
    assert.ok(has(u, 'src/index.ts', 1, 'reexport'), 'barrel re-export found');

    // §3 completeness + precision: the EXACT hand-curated set, not just inclusion — a spurious
    // extra usage (misidentification) or a dropped site would slip an inclusion-only check.
    assert.deepEqual(
      projset(u),
      [
        // The alias import line carries TWO Button refs at distinct columns — the imported name
        // `Button` and the alias binding `B` — both role 'import'; findReferences reports each.
        // (The alias's USE is the separate jsx site at line 4.)
        'src/App.tsx:1:import',
        'src/App.tsx:1:import',
        'src/App.tsx:4:jsx',
        'src/Button.tsx:2:decl',
        'src/index.ts:1:reexport',
      ].sort(),
      'find_usages returns EXACTLY the hand-read semantic set for Button',
    );

    // Distinctness: a word grep for "Button" never matches App.tsx line 4 (it reads `<B`),
    // yet find_usages has it → find_usages ⊋ grep on that site.
    const rg = rgSites(p.root, 'Button');
    if (rg !== undefined) {
      assert.ok(
        !rg.some((s) => s.file === 'src/App.tsx' && s.line === 4),
        'grep misses the aliased usage line (no literal "Button" there)',
      );
      assert.ok(
        rg.some((s) => s.file === 'src/index.ts'),
        'sanity: grep does see the literal re-export',
      );
    }
  } finally {
    await p.dispose();
  }
});

test('type-only aliased import: the `: P` type usage is found, grep misses it', async () => {
  const p = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'Props', collapseImports: false }));
    // `make(p: P)` at App.tsx:3 is a TYPE-position use of Props via the alias P.
    assert.ok(has(u, 'src/App.tsx', 3, 'type'), 'aliased type usage found at the annotation');

    const rg = rgSites(p.root, 'Props');
    if (rg !== undefined) {
      assert.ok(
        !rg.some((s) => s.file === 'src/App.tsx' && s.line === 3),
        'grep misses the `: P` annotation (no literal "Props" on that line)',
      );
    }
  } finally {
    await p.dispose();
  }
});

test('same-named symbols in different scopes: find_usages excludes the unrelated one (grep cannot)', async () => {
  const p = await project(FILES);
  try {
    // Target scopeA's `dup` by position (`const dup` at line 1, col 7).
    const u = usagesOf(
      await p.op('find_usages', { file: 'src/scopeA.ts', line: 1, col: 7, collapseImports: false }),
    );
    const files = new Set(u.map((x) => x.span.file));
    assert.ok(files.has('src/scopeA.ts'), 'the queried symbol’s own refs are present');
    assert.ok(
      !files.has('src/scopeB.ts'),
      'the UNRELATED same-named `dup` in scopeB is excluded — identity, not text',
    );

    // Exact set: scopeA's decl (line 1) + its one read (line 2), and NOTHING else — pins both
    // that scopeB is excluded AND that no spurious site crept in.
    assert.deepEqual(
      projset(u),
      ['src/scopeA.ts:1:decl', 'src/scopeA.ts:2:read'].sort(),
      'find_usages returns EXACTLY scopeA’s own refs',
    );

    // Distinctness the other way: grep for "dup" DOES hit scopeB → find_usages ⊊ grep here.
    const rg = rgSites(p.root, 'dup');
    if (rg !== undefined) {
      assert.ok(
        rg.some((s) => s.file === 'src/scopeB.ts'),
        'grep conflates the two `dup`s (hits scopeB); find_usages did not',
      );
    }
  } finally {
    await p.dispose();
  }
});

type Encloser = { id: string; name: string; kind: string; roles: string; exported: boolean };
function enclosersOf(r: OpResult): Encloser[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { enclosers?: Encloser[] }).enclosers ?? [];
}

test('interface/type-literal member signatures are role `type`, not a spurious value `read`', async () => {
  // find_usages on a value symbol whose references include an interface member SIGNATURE
  // (a class member structurally matching an interface) must classify that signature as a
  // TYPE-level declaration — `type` — never `read`/`write`. Misreading it as `read` made
  // `impact` see a phantom dynamic-dispatch escape on an ordinary symbol (feedback bug 11:44).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/h.ts':
      'export interface Handler { process(): void }\n' + // MethodSignature on line 1
      'export class Impl implements Handler { process(): void {} }\n', // class method on line 2
    'src/shape.ts':
      'export interface Shape { size: number }\n' + // PropertySignature on line 1
      'export class Box implements Shape { size = 1 }\n', // class property on line 2
    'src/acc.ts':
      'export interface HasName {\n' +
      '  get label(): string;\n' + // GetAccessor SIGNATURE on line 2
      '  set label(v: string);\n' + // SetAccessor SIGNATURE on line 3
      '}\n' +
      'export class Tag implements HasName {\n' +
      '  get label(): string {\n    return "";\n  }\n' + // class getter on line 6
      '  set label(v: string) {}\n' + // class setter on line 9
      '}\n',
  });
  try {
    // Target the CLASS method `process` (h.ts:2:40); its references include the interface
    // MethodSignature on line 1.
    const m = usagesOf(
      await p.op('find_usages', { file: 'src/h.ts', line: 2, col: 40, collapseImports: false }),
    );
    assert.ok(has(m, 'src/h.ts', 1, 'type'), 'the interface MethodSignature is role `type`');
    assert.ok(has(m, 'src/h.ts', 2, 'decl'), 'the class method itself is the decl');
    assert.ok(
      !m.some((x) => x.role === 'read' || x.role === 'write'),
      'no occurrence is a spurious value read/write',
    );

    // Same for a PropertySignature (Box.size at shape.ts:2:37).
    const prop = usagesOf(
      await p.op('find_usages', { file: 'src/shape.ts', line: 2, col: 37, collapseImports: false }),
    );
    assert.ok(
      has(prop, 'src/shape.ts', 1, 'type'),
      'the interface PropertySignature is role `type`',
    );
    assert.ok(
      !prop.some((x) => x.role === 'read' || x.role === 'write'),
      'no occurrence is a spurious value read/write',
    );

    // Accessor SIGNATURES (`get`/`set`) in an interface are GetAccessor/SetAccessor nodes,
    // not Method/PropertySignature — they must ALSO be role `type`, never `read`/`write`.
    // Target the class getter (acc.ts:6) and setter (acc.ts:9); both link to the signatures.
    const getter = usagesOf(
      await p.op('find_usages', { file: 'src/acc.ts', line: 6, col: 7, collapseImports: false }),
    );
    assert.ok(
      has(getter, 'src/acc.ts', 2, 'type'),
      'the interface get-accessor signature is `type`',
    );
    assert.ok(
      !getter.some((x) => x.role === 'read' || x.role === 'write'),
      'getter: no spurious value read/write',
    );
    const setter = usagesOf(
      await p.op('find_usages', { file: 'src/acc.ts', line: 9, col: 7, collapseImports: false }),
    );
    assert.ok(
      has(setter, 'src/acc.ts', 3, 'type'),
      'the interface set-accessor signature is `type`',
    );
    assert.ok(
      !setter.some((x) => x.role === 'read' || x.role === 'write'),
      'setter: no spurious value read/write',
    );
  } finally {
    await p.dispose();
  }
});

test('a reference in a top-level value binding rolls up to that binding, not the module node', async () => {
  // `export const b = a()` / `export const cfg = { f: a }` reference `a` from a top-level
  // NON-function binding. Each rolls up to its own binding encloser (kind `const`) carrying
  // a re-resolvable `name@file:line:col` SymbolId — NOT the synthetic `(top-level b.ts)`
  // module node that dead-ends any transitive tool (feedback bug 11:45).
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/a.ts': 'export const a = (): number => 1;\n',
    'src/b.ts':
      "import { a } from './a';\n" + 'export const b = a();\n' + 'export const cfg = { f: a };\n',
  });
  try {
    const enclosers = enclosersOf(await p.op('find_usages', { name: 'a', groupBy: 'enclosing' }));
    const byName = new Map(enclosers.map((e) => [e.name, e]));

    const b = byName.get('b');
    if (b === undefined) throw new Error('binding b is not an encloser');
    assert.equal(b.kind, 'const', 'b is a `const` encloser, not `module`');
    assert.ok(b.id.includes('b@src/b.ts:2:'), 're-resolvable binding id at b’s position');

    const cfg = byName.get('cfg');
    if (cfg === undefined) throw new Error('binding cfg is not an encloser');
    assert.equal(cfg.kind, 'const');
    assert.ok(cfg.id.includes('cfg@src/b.ts:3:'), 're-resolvable binding id at cfg’s position');

    // The b.ts value refs are accounted for by the bindings themselves — not folded into a
    // `(top-level b.ts)` module rollup (which would carry a `call`/`read` role and dead-end).
    const bModule = enclosers.find((e) => e.name === '(top-level b.ts)');
    assert.ok(
      bModule === undefined || (!bModule.roles.includes('call') && !bModule.roles.includes('read')),
      'no value-ref rolled into the b.ts module node',
    );

    // The re-resolvable id chains straight back into another op (the dead-end is closed).
    const chained = await p.op('find_usages', { symbol: b.id });
    assert.ok('result' in chained && chained.result.ok, 'the binding id resolves on its own');
  } finally {
    await p.dispose();
  }
});

test('every semantic usage carries certain confidence (no dynamic hop in static refs)', async () => {
  const p = await project(FILES);
  try {
    const u = usagesOf(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    assert.ok(u.length > 0);
    assert.ok(
      u.every((x) => x.confidence === 'certain'),
      'statically-resolved refs are type-proven, never partial/dynamic',
    );
  } finally {
    await p.dispose();
  }
});
