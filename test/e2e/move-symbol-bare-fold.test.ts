// Regression oracle for the move-produced default+named same-module duplicate (dogfood 2026-06-21):
// the LS "Move to file" merges a move's own imports into the dest's existing import for a relative /
// alias specifier, but for a BARE specifier (an npm package) it leaves the moved default + the dest's
// existing named (or two fresh-dest statements) as SEPARATE lines — `import dep from 'lib'` +
// `import { helper } from 'lib'` instead of `import dep, { helper } from 'lib'`. Typecheck-clean → the
// §2.8 gate waves it through → the agent must hand-tidy. `move_symbol` now folds that move-CREATED dup
// (guarded to exclude dest's PRE-EXISTING duplicates — the scoped-edit contract). Oracle: an INDEPENDENT
// cold ts.Program over the post-apply tree compiles clean, git byte-exact, and the dest carries ONE
// import line for the module. Not golden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { JsonValue } from '../../src/core/json.ts';
import { project, type TestProject } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve","esModuleInterop":true}}';

// A bare-specifier package `lib` with both a default and a named export — no npm install needed.
const LIB = {
  'node_modules/lib/package.json': '{"name":"lib","types":"index.d.ts"}',
  'node_modules/lib/index.d.ts':
    'declare const dep: () => number;\nexport default dep;\nexport const helper: number;\nexport const other: number;\n',
};

type Envelope = { mode: string; diff: string; typecheck: { clean: boolean }; applied?: boolean };

async function move(p: TestProject, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'move_symbol', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

function libImportLines(dest: string): string[] {
  return dest.split('\n').filter((l) => /from\s+['"]lib['"]/.test(l));
}

test('move_symbol: folds a BARE-specifier moved-default into the dest existing named line', async () => {
  // bareB: dest has `import { helper } from 'lib'`; the moved symbol uses the default `dep`.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    ...LIB,
    'src/source.ts': "import dep from 'lib';\n\nexport const moved = () => dep();\n",
    'src/dest.ts': "import { helper } from 'lib';\n\nexport const existing = helper;\n",
  });
  try {
    const dry = await move(p, { name: 'moved', dest: 'src/dest.ts' });
    assert.equal(dry.typecheck.clean, true, `bad merge: ${dry.diff}`);
    assert.equal(p.git('status', '--porcelain'), ''); // dry-run wrote nothing

    const applied = await move(p, { name: 'moved', dest: 'src/dest.ts' }, true);
    assert.equal(applied.applied, true, `apply refused: ${JSON.stringify(applied)}`);
    assert.equal(applied.diff, dry.diff); // diff(dry-run) === diff(apply)

    assert.deepEqual(coldDiagnostics(p.root), []); // independent oracle compiles clean
    const dest = readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8');
    // The discriminating assertion: ONE import line from 'lib', carrying both bindings.
    assert.deepEqual(libImportLines(dest), ["import dep, { helper } from 'lib';"], dest);
    assert.match(dest, /export const moved/, 'symbol landed in dest');
  } finally {
    await p.dispose();
  }
});

test('move_symbol: folds a BARE-specifier default+named both moved into a fresh dest', async () => {
  // bareC: the moved symbol uses BOTH a default and a named from `lib`; dest imports nothing from it.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    ...LIB,
    'src/source.ts':
      "import dep, { helper } from 'lib';\n\nexport const moved = () => dep() + helper;\n",
    'src/dest.ts': 'export const existing = 1;\n',
  });
  try {
    const applied = await move(p, { name: 'moved', dest: 'src/dest.ts' }, true);
    assert.equal(applied.applied, true, `apply refused: ${JSON.stringify(applied)}`);
    assert.deepEqual(coldDiagnostics(p.root), []);
    const dest = readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8');
    assert.deepEqual(libImportLines(dest), ["import dep, { helper } from 'lib';"], dest);
    assert.match(dest, /export const moved/, 'symbol landed in dest');
  } finally {
    await p.dispose();
  }
});

test('move_symbol: leaves a PRE-EXISTING dest duplicate untouched (no over-reach)', async () => {
  // Control: dest ALREADY splits `lib` across two statements (a pre-existing dup the move did not
  // create). The moved symbol does NOT import from `lib`, so the fold must leave both lines byte-exact.
  const destBefore =
    "import dep from 'lib';\nimport { helper } from 'lib';\n\nexport const existing = dep() + helper;\n";
  const p = await project({
    'tsconfig.json': TSCONFIG,
    ...LIB,
    'src/source.ts': 'export const moved = () => 41 + 1;\n',
    'src/dest.ts': destBefore,
  });
  try {
    const applied = await move(p, { name: 'moved', dest: 'src/dest.ts' }, true);
    assert.equal(applied.applied, true, `apply refused: ${JSON.stringify(applied)}`);
    assert.deepEqual(coldDiagnostics(p.root), []);
    const dest = readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8');
    // The pre-existing dup is preserved — both lines still present, NOT consolidated.
    assert.deepEqual(libImportLines(dest), [
      "import dep from 'lib';",
      "import { helper } from 'lib';",
    ]);
  } finally {
    await p.dispose();
  }
});

test('move_symbol: a move adding to a PRE-EXISTING dest dup does not consolidate it', async () => {
  // Mixed: dest already has TWO `lib` statements (default + a named), AND the moved symbol adds
  // another `lib` named import. Since `lib` was duplicated BEFORE the move, the whole group is out of
  // scope — we never consolidate it (conservative; the pre-existing lines stay, the move's add stays
  // separate). Proves the skip-set guards even when the move contributes to the module.
  const p = await project({
    'tsconfig.json': TSCONFIG,
    ...LIB,
    'src/source.ts': "import { other } from 'lib';\n\nexport const moved = () => other;\n",
    'src/dest.ts':
      "import dep from 'lib';\nimport { helper } from 'lib';\n\nexport const existing = dep() + helper;\n",
  });
  try {
    const applied = await move(p, { name: 'moved', dest: 'src/dest.ts' }, true);
    assert.equal(applied.applied, true, `apply refused: ${JSON.stringify(applied)}`);
    assert.deepEqual(coldDiagnostics(p.root), []);
    const dest = readFileSync(path.join(p.root, 'src/dest.ts'), 'utf8');
    // NOT folded to ONE line: had our fold ignored the skip-set it would have collapsed the
    // pre-existing `dep`/`helper` split into a single `import dep, { other, helper } from 'lib';`.
    // The skip leaves the pre-existing dup as the move found it (≥2 lines).
    assert.ok(
      libImportLines(dest).length >= 2,
      `pre-existing dup must not be consolidated to one line: ${dest}`,
    );
    for (const n of ['dep', 'helper', 'other']) {
      assert.match(dest, new RegExp(`\\b${n}\\b`), `dest keeps ${n}`);
    }
  } finally {
    await p.dispose();
  }
});
