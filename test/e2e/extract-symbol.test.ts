// Stage G edit-safety oracle for extract_symbol (§16.4). Oracles: a cold ts.Program compile
// (the extracted symbol resolves from its new home, the source imports it back),
// diff(dry)==diff(apply), and the honest-failure path — an extract the LS can't make clean is
// REFUSED (§2.8), never half-written. The `Expected symbol to be a module` assertion recognizer
// is unit-pinned; a css-using component that trips it is rescued via the §4 patched LS (below).
// CSS co-extract has its own end-to-end suite (extract-css-coextract.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics as coldTscErrors } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';
import {
  isExtractAssertion,
  isLsDebugFailure,
} from '../../src/plugins/ts/refactor/extract/taxonomy.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
  notes?: string[];
};
type Proj = Awaited<ReturnType<typeof project>>;

async function extract(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([
    { name: 'extract_symbol', args, ...(apply ? { apply: true } : {}) },
  ]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('extract_symbol: a top-level symbol moves to a new file; source imports it back', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
  });
  try {
    const dry = await extract(p, { name: 'helper', dest: 'src/lib/helper.ts' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes
    assert.ok(!existsSync(path.join(p.root, 'src/lib/helper.ts')));

    const applied = await extract(p, { name: 'helper', dest: 'src/lib/helper.ts' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    // Independent cold compile — the symbol resolves from its new home, source imports it back.
    assert.deepEqual(coldTscErrors(p.root), []);
    assert.match(
      readFileSync(path.join(p.root, 'src/lib/helper.ts'), 'utf8'),
      /export const helper/,
    );
    assert.match(
      readFileSync(path.join(p.root, 'src/main.ts'), 'utf8'),
      /import \{ helper \} from ['"]\.\/lib\/helper['"]/,
    );
    assert.doesNotMatch(
      readFileSync(path.join(p.root, 'src/main.ts'), 'utf8'),
      /export const helper/,
    );
  } finally {
    await p.dispose();
  }
});

test('§4a: extracting a NESTED symbol refuses — never silently retargets the enclosing top-level', async () => {
  // `BoundInput` is declared INSIDE `useAppForm`. The LS "Move to a new file" refactor acts on the
  // enclosing top-level statement, so without the guard this silently extracts the whole
  // `useAppForm` — a different symbol than asked for. It must refuse with a ts-ls category.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/form.ts':
      'export const useAppForm = () => {\n' +
      '  const BoundInput = (p: { v: string }): string => p.v;\n' +
      '  return { BoundInput };\n' +
      '};\n',
  });
  try {
    // line 2, col 9 → the `B` of the nested `const BoundInput`.
    const [r] = await p.request([
      {
        name: 'extract_symbol',
        args: { file: 'src/form.ts', line: 2, col: 9, dest: 'src/lib/bound.ts' },
        apply: true,
      },
    ]);
    assert.ok(
      r !== undefined && 'result' in r && !r.result.ok,
      'a nested target must refuse, not retarget',
    );
    if ('result' in r && !r.result.ok) {
      assert.match(r.result.failure.message, /nested|TOP-LEVEL/);
    }
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written, useAppForm untouched
  } finally {
    await p.dispose();
  }
});

test('§4a: extracting a MEMBER (enum/object/interface/class field) refuses — never moves the whole container', async () => {
  // The bug-review caught that the first guard only saw function/block/module boundaries, so a
  // member whose own declaration is a property/enum/signature slipped through and the LS silently
  // moved the ENTIRE enum/object/interface/class. Each member sits at line 2, col 3.
  const cases: { label: string; src: string }[] = [
    { label: 'enum member', src: 'export enum E {\n  A = 1,\n  B = 2,\n}\n' },
    {
      label: 'object-literal property',
      src: 'export const cfg = {\n  handler: 1,\n  other: 2,\n};\n',
    },
    { label: 'interface member', src: 'export interface I {\n  foo: number;\n  bar: number;\n}\n' },
    { label: 'class arrow-property', src: 'export class C {\n  handler = (): number => 1;\n}\n' },
  ];
  for (const c of cases) {
    const p = await project({ 'tsconfig.json': TSCONFIG, 'src/m.ts': c.src });
    try {
      const [r] = await p.request([
        {
          name: 'extract_symbol',
          args: { file: 'src/m.ts', line: 2, col: 3, dest: 'src/out.ts' },
          apply: true,
        },
      ]);
      assert.ok(
        r !== undefined && 'result' in r && !r.result.ok,
        `${c.label}: a member target must refuse, not move the whole container`,
      );
      if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /nested|TOP-LEVEL/);
      assert.equal(p.git('status', '--porcelain'), '', `${c.label}: nothing written`);
    } finally {
      await p.dispose();
    }
  }
});

test('extract_symbol: an unsatisfiable extract fails honestly (no crash, nothing written)', async () => {
  // The `Expected symbol to be a module` LS assertion is version-specific and not
  // reproducible here; the recognizer + wrapping are unit-pinned below. This pins that a
  // refused extract (dest already exists) surfaces a ToolFailure, never a crash / half-write.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/main.ts':
      'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
    'src/lib.ts': 'export const other = 1;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'extract_symbol', args: { name: 'helper', dest: 'src/lib.ts' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'dest-collision must fail');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /already exists/);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: refuses to overwrite a gitignored file at dest, even with dirtyOk', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    '.gitignore': 'src/gen/\n',
    'src/main.ts':
      'export const helper = (x: number): number => x * 2;\nexport const main = (): number => helper(3);\n',
  });
  try {
    // A gitignored file at dest is excluded from ls-files → invisible to the tree's
    // dest-collision guard, but present on disk. Overwriting it is unrecoverable, so the
    // existsSync backstop must refuse REGARDLESS of dirtyOk.
    p.write('src/gen/helper.ts', 'export const precious = 99;\n');
    const [r] = await p.request([
      {
        name: 'extract_symbol',
        args: { name: 'helper', dest: 'src/gen/helper.ts', dirtyOk: true },
        apply: true,
      },
    ]);
    assert.ok(r !== undefined && 'result' in r && r.result.ok);
    const data = r.result.data as unknown as Envelope & { reason?: string };
    assert.equal(data.applied, false);
    assert.match(String(data.reason), /refusing to overwrite/);
    assert.equal(
      readFileSync(path.join(p.root, 'src/gen/helper.ts'), 'utf8'),
      'export const precious = 99;\n',
    );
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: §4 rescue extracts a css-using component the stock LS asserts on', async () => {
  // The extracted block uses `s.card` — the stock LS throws `Expected symbol to be a module`
  // here. The patched-LS rescue produces the edits; the project's own TS post-typecheck still
  // gates apply (§2.8). Oracle: an independent cold compile + the `rescued` provenance note.
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"preserve","jsx":"preserve"}}',
    'src/scss.d.ts':
      "declare module '*.module.scss' { const s: { [k: string]: string }; export default s; }",
    'src/jsx.d.ts':
      'declare namespace JSX { interface Element {} interface IntrinsicElements { [e: string]: unknown } }',
    'src/feature/Panel.module.scss': '.card { color: red; }\n.shared { margin: 0; }\n',
    'src/feature/Panel.tsx':
      "import s from './Panel.module.scss';\n" +
      'export const Card = (): JSX.Element => <div className={s.card} />;\n' +
      'export const Panel = (): JSX.Element => <section className={s.shared} />;\n',
  });
  try {
    const applied = await extract(p, { name: 'Card', dest: 'src/widgets/Card.tsx' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.applied, true);
    assert.equal(applied.typecheck.clean, true);
    assert.ok(
      (applied.notes ?? []).some((n) => /rescue/.test(n)),
      `expected a rescue provenance note, got ${JSON.stringify(applied.notes)}`,
    );
    assert.deepEqual(coldTscErrors(p.root), []); // the moved .tsx compiles from its new home
    assert.match(
      readFileSync(path.join(p.root, 'src/widgets/Card.tsx'), 'utf8'),
      /export const Card/,
    );
  } finally {
    await p.dispose();
  }
});

test('extract taxonomy: only the module assertion earns the workaround note', () => {
  assert.equal(isExtractAssertion('Debug Failure. Expected symbol to be a module'), true);
  assert.equal(isExtractAssertion('Some other Debug Failure.'), false); // generic — no false category
  assert.equal(isLsDebugFailure('Some other Debug Failure.'), true);
  assert.equal(isExtractAssertion('Cannot find name foo'), false);
});
