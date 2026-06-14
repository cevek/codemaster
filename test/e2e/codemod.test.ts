// Stage H oracle for codemod (§16.4 edit-safety) — shape-based ast-grep rewrite. Oracles:
// a hand-written expected output, an independent cold ts.Program compile, and the load-bearing
// "matches shape, not symbol" assertion — a same-named binding that does NOT match the
// pattern's AST shape is left untouched (the safety distinction from rename_symbol).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

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

type Envelope = { mode: string; diff: string; touched: string[]; typecheck: { clean: boolean } };
type Proj = Awaited<ReturnType<typeof project>>;

async function codemod(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'codemod', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

test('codemod: shape-based rewrite — only the matching AST shape, not the same-named ident', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const f = (...xs: number[]): number => xs.length;\n',
    'src/use.ts': "import { f } from './api';\nexport const keep = f;\nexport const call = f(1);\n",
  });
  try {
    const args = { pattern: 'f($A)', rewrite: 'f($A, 2)' };
    const dry = await codemod(p, args);
    assert.equal(dry.mode, 'dry-run');
    assert.equal(dry.typecheck.clean, true);
    assert.deepEqual(dry.touched, ['src/use.ts']); // api.ts has no call — untouched
    assert.match(dry.diff, /f\(1, 2\)/);
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes

    const applied = await codemod(p, args, true);
    assert.equal(applied.mode, 'applied');
    assert.equal(applied.typecheck.clean, true);
    assert.equal(applied.diff, dry.diff); // diff(dry) === diff(apply)

    const use = readFileSync(path.join(p.root, 'src/use.ts'), 'utf8');
    assert.match(use, /export const call = f\(1, 2\);/); // the CALL shape was rewritten
    assert.match(use, /export const keep = f;/); // the bare identifier (not f($A)) untouched
    assert.deepEqual(coldTscErrors(p.root), []); // independent compile
  } finally {
    await p.dispose();
  }
});

test('codemod: a rewrite metavar the pattern never captures is rejected (not emitted literally)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.ts': 'export const x = f(1);\nexport const f = (n: number): number => n;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'codemod', args: { pattern: 'f($A)', rewrite: 'g($A, $B)' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'unbound $B must fail');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /\$B/);
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('codemod: a $ vs $$$ sigil mismatch in the rewrite is rejected (no literal $X emitted)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.ts':
      'export const x = f(1, 2, 3);\nexport const f = (...n: number[]): number => n.length;\n',
  });
  try {
    // pattern captures $$$A (multi) but the rewrite references $A (single) — getMatch('A') is
    // null, so $A would be emitted literally. Must be rejected, not silently wrong.
    const [r] = await p.request([
      { name: 'codemod', args: { pattern: 'f($$$A)', rewrite: 'g($A)' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'sigil mismatch must fail');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /sigil|not captured/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('codemod: a rewrite that breaks an UN-MATCHED importer is caught (whole-program gate)', async () => {
  // The completeness trap: codemod is shape-based, so renaming an exported decl matches ONLY
  // the defining file; its importers don't match the pattern and never enter `changes`. A
  // gate scoped to changed files alone would report clean over a dangling import. The §2.8
  // gate must typecheck the WHOLE program so the broken importer is caught and apply refused.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts': 'export const oldName = 1;\n',
    'src/use.ts': "import { oldName } from './api';\nexport const y = oldName + 1;\n",
  });
  try {
    const env = await codemod(
      p,
      { pattern: 'export const oldName = $A', rewrite: 'export const newName = $A' },
      true,
    );
    assert.equal(env.typecheck.clean, false); // use.ts's `import { oldName }` now dangles
    assert.equal((env as { applied?: boolean }).applied, false); // refused — not applied
    assert.equal(p.git('status', '--porcelain'), ''); // nothing written
  } finally {
    await p.dispose();
  }
});

test('codemod: a `$$X` metavariable is rejected (not expanded with a stray $)', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.ts': 'export const x = f(1);\nexport const f = (n: number): number => n;\n',
  });
  try {
    const [r] = await p.request([
      { name: 'codemod', args: { pattern: 'f($A)', rewrite: 'g($$A)' }, apply: true },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, '$$X must be rejected');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /\$\$|not supported/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('codemod: a paths entry escaping the repo root is rejected', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.ts': 'export const x = 1;\n',
  });
  try {
    const [r] = await p.request([
      {
        name: 'codemod',
        args: { pattern: 'f($A)', rewrite: 'g($A)', paths: ['../escape.ts'] },
        apply: true,
      },
    ]);
    assert.ok(r !== undefined && 'result' in r && !r.result.ok, 'escaping path must be rejected');
    if ('result' in r && !r.result.ok) assert.match(r.result.failure.message, /escape/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});

test('codemod: a pattern that matches nothing writes nothing and stays clean', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/x.ts': 'export const x = 1;\n',
  });
  try {
    const r = await codemod(p, { pattern: 'noSuchCall($A)', rewrite: 'other($A)' }, true);
    assert.deepEqual(r.touched, []);
    assert.equal(r.typecheck.clean, true);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    await p.dispose();
  }
});
