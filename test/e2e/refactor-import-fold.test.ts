// Oracle for FIX B (dogfood, amiro 2026-06-21): the TS "Move to a new file" / "Move to file"
// refactors can leave two separate import statements from the SAME module in the relocated file (a
// default import on one line, a named import on another) instead of one merged `import def, { x }
// from 'm'`. Typecheck-clean → the §2.8 gate waves it through → the agent must hand-tidy.
//
// The fold is EXTRACT-ONLY by scope choice. move_symbol CAN produce its own default+named dup (a
// separate open bug, docs/backlog.md), but a whole-dest fold can't tell a move-produced dup from a
// PRE-EXISTING dest split, so folding would risk an unrequested refactor exceeding the op's scoped-edit
// contract — the move_symbol test below asserts a pre-existing dest split is left untouched.
//
// Oracles, neither golden:
//   ONE STATEMENT (discriminating, red→green) — the extracted file ends with EXACTLY one import
//     statement for the module. Fails on the pre-fix code (two statements).
//   SCOPED DIFF — move_symbol leaves a dest's pre-existing same-module split untouched.
//   NO MIS-FOLD — a type-only default is never merged into a value import (no silent runtime import).
//   COMPILES — an independent cold `ts.Program` over the post-apply tree is clean.
//
// NOTE on the reported trigger: amiro's report named "multiple @tanstack/react-query lines". react-
// query is named-only, and only **named+named** is VERIFIED to always merge (incl. under
// verbatimModuleSyntax), so that exact shape does not reproduce; the concrete EXTRACT mergeable gap is
// default+named. A namespace+named pair (`import * as RQ` + `import { x }`) is a legal-but-unmergeable
// form and is left as-is — not a bug. See docs/backlog.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve","esModuleInterop":true}}';

async function applyOp(p: TestProject, name: string, args: JsonValue): Promise<void> {
  const [r] = await p.request([{ name, args, apply: true }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result).slice(0, 300)}`);
}

const read = (p: TestProject, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');
const importsOf = (content: string, spec: string): number =>
  content.split('\n').filter((l) => /^\s*import\b/.test(l) && l.includes(`'${spec}'`)).length;

const LIB =
  'declare const d: (n: number) => number;\nexport default d;\n' +
  'export const named = (n: number): number => n;\nexport const other = (n: number): number => n;\n';

test('extract_symbol: default + named from one module fold into a single statement', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib.ts': LIB,
    'src/source.ts':
      "import def from './lib';\n" +
      "import { named } from './lib';\n\n" +
      'export const moved = (): number => def(1) + named(2);\n',
  });
  try {
    await applyOp(p, 'extract_symbol', { name: 'moved', dest: 'src/moved.ts' });
    const dest = read(p, 'src/moved.ts');
    assert.equal(
      importsOf(dest, './lib'),
      1,
      `expected one import statement for './lib':\n${dest}`,
    );
    assert.match(dest, /import def, \{ named \} from '\.\/lib'/, dest);
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: does NOT consolidate the dest pre-existing duplicate imports (scoped diff)', async () => {
  // move_symbol folds NOTHING (extract-only): folding would touch a PRE-EXISTING same-module split the
  // move did not create — an unrequested refactor exceeding the op's contract (mutate only the moved
  // symbol + its imports). So a dest carrying two same-module statements keeps BOTH untouched. (Separate
  // open bug: move_symbol can PRODUCE its own default+named dup — see docs/backlog.md — not folded here.)
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/lib.ts': LIB,
    'src/dest.ts':
      "import { named } from './lib';\n" +
      "import { other } from './lib';\n\n" +
      'export const ex = (): number => named(0) + other(0);\n',
    'src/source.ts': 'export const moved = (): number => 1;\n',
  });
  try {
    await applyOp(p, 'move_symbol', { name: 'moved', dest: 'src/dest.ts' });
    const dest = read(p, 'src/dest.ts');
    // The pre-existing split is preserved verbatim — the move only appended its own symbol.
    assert.equal(importsOf(dest, './lib'), 2, `pre-existing imports must be untouched:\n${dest}`);
    assert.match(
      dest,
      /import \{ named \} from '\.\/lib';\nimport \{ other \} from '\.\/lib';/,
      dest,
    );
    assert.match(dest, /export const moved/, dest);
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});

test('extract_symbol: a type-only default + a named import are NOT mis-folded (no runtime import added)', async () => {
  // `import type D from 'm'` + `import { b } from 'm'` must NOT fold to `import D, { b }` — that drops
  // the `type` and, under verbatimModuleSyntax, silently adds a RUNTIME import of a type-only default (a
  // §2.8-invisible semantic change). The fold leaves the group split, `type D` preserved.
  const p = await project({
    'tsconfig.json':
      '{"compilerOptions":{"strict":true,"module":"preserve","verbatimModuleSyntax":true}}',
    // `D` is a class (value+type) so `import type D` is a legal type-only default; the mis-fold to a
    // runtime `import D` is SILENT (compiles clean) — the text assertion is the discriminator.
    'src/lib.ts':
      'export default class D {\n  x = 0;\n}\nexport const b = (n: number): number => n;\n',
    'src/source.ts':
      "import type D from './lib';\n" +
      "import { b } from './lib';\n\n" +
      'export const moved = (x: D): number => b(x.x);\n',
  });
  try {
    await applyOp(p, 'extract_symbol', { name: 'moved', dest: 'src/moved.ts' });
    const dest = read(p, 'src/moved.ts');
    // The type-only default keeps its `type` and is not merged into a value import.
    assert.match(
      dest,
      /import type D from '\.\/lib'/,
      `type-only default lost its modifier:\n${dest}`,
    );
    assert.doesNotMatch(dest, /import D, \{/, `mis-folded into a runtime default import:\n${dest}`);
    assert.deepEqual(coldDiagnostics(p.root), []);
  } finally {
    await p.dispose();
  }
});
