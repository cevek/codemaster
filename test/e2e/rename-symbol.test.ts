// Stage D edit-safety oracle for rename_symbol (§16.4), git-backed. Oracles, independent of
// the warm LS that performed the rename:
//   · dry-run leaves `git status` clean (zero writes);
//   · diff(dry) === diff(apply);
//   · post-apply a COLD ts.Program compiles clean — and because a missed import rewrite
//     would surface as "no exported member", that cold compile IS the semantic oracle;
//   · the §2.8 NEGATIVE gate: a colliding rename is refused with an unclean typecheck and
//     leaves every file byte-identical (no apply without a clean post-edit typecheck).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

/** Independent oracle: a fresh-from-cold Program over the on-disk tree (never the warm LS). */
function coldTscErrors(root: string): string[] {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (configPath === undefined) return ['no tsconfig'];
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

type Envelope = {
  mode: string;
  diff: string;
  touched: string[];
  typecheck: { clean: boolean };
  applied?: boolean;
  rollback?: { performed: boolean };
};
type Proj = Awaited<ReturnType<typeof project>>;

/** Drive rename_symbol via a full OpRequest so the `apply` flag rides at the top level
 *  (it is an OpFlag, not an op arg — the strict args schema rejects it inside `args`). */
async function rename(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'rename_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('rename_symbol: applies despite an UNRELATED pre-existing type error (narrow gate)', async () => {
  // rename's changeset is LS-complete, so the §2.8 gate checks only the TOUCHED files — a
  // pre-existing error elsewhere must NOT block it (the hot path stays usable on real repos
  // that don't fully compile). Only shape-based codemod widens to the whole program.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const greet = (n: string): string => n;\n',
    'src/use.ts': "import { greet } from './api';\nexport const a = greet('hi');\n",
    'src/broken.ts': "export const bad: number = 'not a number';\n", // pre-existing, unrelated
  });
  try {
    const env = await rename(p, { name: 'greet', newName: 'greet2' }, true);
    assert.equal(env.applied, true); // not blocked by broken.ts
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /greet2\(['"]hi['"]\)/);
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: dry-run zero-write, diff parity, cold-tsc-clean apply', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/math.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    'src/use.ts': "import { add as plus } from './math';\nexport const r: number = plus(1, 2);\n",
  });
  try {
    // Dry-run: previews both the declaration and the aliased import specifier; writes nothing.
    const dry = await rename(p, { name: 'add', newName: 'sum' });
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true);
    assert.deepEqual([...dry.touched].sort(), ['src/math.ts', 'src/use.ts']);
    assert.match(dry.diff, /sum/);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes

    // Apply: identical diff, committed, post-apply typecheck clean, no rollback.
    const applied = await rename(p, { name: 'add', newName: 'sum' }, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.rollback?.performed, false);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    // On-disk result + the INDEPENDENT cold compile (a missed import rewrite would fail it).
    assert.match(readFileSync(path.join(p.root, 'src/math.ts'), 'utf8'), /export const sum/);
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /import \{ sum as plus \}/);
    assert.deepEqual(coldTscErrors(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: a shorthand property keeps its key (foo → { foo: bar }, not { bar })', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/a.ts': 'const foo = 1;\nexport const o = { foo };\nexport const u = o.foo;\n',
  });
  try {
    const applied = await rename(p, { name: 'foo', newName: 'bar' }, true);
    assert.equal(applied.typecheck.clean, true);
    assert.deepEqual(coldTscErrors(p.root), []);
    const a = readFileSync(path.join(p.root, 'src/a.ts'), 'utf8');
    assert.match(a, /\{ foo: bar \}/); // the KEY stays foo; only the value renames
    assert.doesNotMatch(a, /\{ bar \}/); // NOT a key rename (would change the object shape)
  } finally {
    await p.dispose();
  }
});

test('rename_symbol: §2.8 gate — a colliding rename is refused, every file byte-identical', async () => {
  const before = {
    math: 'export const add = (a: number, b: number): number => a + b;\nexport const sum = (a: number, b: number): number => a * b;\n',
    use: "import { add } from './math';\nexport const r: number = add(1, 2);\n",
  };
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/math.ts': before.math,
    'src/use.ts': before.use,
  });
  try {
    // add -> sum collides with the existing `sum`; the post-edit typecheck must catch it.
    const r = await rename(p, { name: 'add', newName: 'sum' }, true);
    assert.equal(r.typecheck.clean, false); // duplicate-identifier diagnostic
    assert.equal(r.applied, false); // apply refused (§2.8) — never wrote
    assert.notEqual(r.mode, 'applied');
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes
    assert.equal(readFileSync(path.join(p.root, 'src/math.ts'), 'utf8'), before.math);
    assert.equal(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), before.use);
  } finally {
    await p.dispose();
  }
});
