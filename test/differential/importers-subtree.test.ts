// Subtree-scoped `importers_of` (T3): "who imports ANYTHING under this folder" in one call —
// the "is it safe to delete this folder?" question. The honesty core (§3.4):
//   - EXTERNAL importers (their own file OUTSIDE the subtree) are deletion BLOCKERS — the headline.
//   - INTERNAL importers (file INSIDE the subtree) are counted + kept, marked non-blocking, never
//     silently dropped.
//   - an import whose spec does NOT resolve to a file can't be confirmed under the subtree → it is
//     FLAGGED `unconfirmed` (lexical-under-subtree), never raw-string matched (backlog 446a false-LIVE).
//   - "safe" is gated on `complete===true && unconfirmed===0` (an undiscovered config or an
//     unconfirmed ref is a LOWER BOUND, not proof).
//
// ORACLE (independent, target-centric): EXTERNAL must equal
//   (∪ over each file F under the subtree of single-module `importers_of(F)`) MINUS importers whose
//   own file is inside the subtree. The op computes it import-centric (resolve each spec, test
//   containment), so the oracle is a genuinely different path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';

const COMPILER = '{"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx"}';

type Row = { at: string; imports: string; target?: string; scope?: string };
type Unconf = { at: string; spec: string; reason: string };
type SubtreeData = {
  mode?: string;
  subtree?: string;
  safe?: boolean;
  complete?: boolean;
  blockers?: number;
  external?: Row[];
  internal?: Row[];
  unconfirmed?: Unconf[];
};

async function subtree(p: TestProject, module: string): Promise<SubtreeData> {
  const r = await p.op('importers_of', { module });
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as SubtreeData;
}

/** files (not statements) of a row list */
const files = (rows: Row[] | undefined): string[] => [
  ...new Set((rows ?? []).map((x) => x.at.slice(0, x.at.lastIndexOf(':')))),
];

// ── Fixture A+D+E: barrel + deep + internal + nested re-export, with the ORACLE ─────────────────
// `baseUrl:"."` is deliberate: it makes the bare arg `src/feature` RESOLVE to `src/feature/index.ts`,
// so a (wrong) resolution-first rule would collapse the subtree to its barrel and SILENTLY DROP the
// deep importer of `src/feature/sub`. Asserting that deep importer is EXTERNAL locks in directory-wins.
const FEATURE = {
  'tsconfig.json': `{"compilerOptions":${COMPILER.slice(0, -1)},"baseUrl":"."},"include":["src"]}`,
  'src/feature/index.ts': "export { helper } from './helper';\n", // E: nested re-export from under the folder
  'src/feature/helper.ts': 'export const helper = 1;\n',
  'src/feature/sub.ts': 'export const sub = 2;\n',
  'src/feature/internal-user.ts': "import { sub } from './sub';\nexport const iu = sub;\n", // D: INTERNAL
  'src/app/usesBarrel.tsx': "import { helper } from '../feature';\nexport const b = helper;\n", // external → index (barrel)
  'src/app/usesSub.tsx': "import { sub } from '../feature/sub';\nexport const s = sub;\n", // external → DEEP
  'src/app/unrelated.ts': 'export const z = 3;\n',
};

test('subtree: external = barrel-importer ∪ deep-importer (directory-wins; resolution-first would drop the deep one)', async () => {
  const p = await project(FEATURE);
  try {
    const d = await subtree(p, 'src/feature');
    assert.equal(d.mode, 'subtree', 'mode is explicit in the output');
    assert.equal(d.subtree, 'src/feature');
    const ext = files(d.external);
    assert.ok(
      ext.some((f) => f.endsWith('app/usesBarrel.tsx')),
      `barrel importer external: ${ext.join(',')}`,
    );
    assert.ok(
      ext.some((f) => f.endsWith('app/usesSub.tsx')),
      `DEEP importer external (the discriminator): ${ext.join(',')}`,
    );
    assert.equal(d.blockers, 2, 'blockers = distinct external files');
  } finally {
    await p.dispose();
  }
});

test('subtree: internal importer is counted + kept, marked non-blocking (never silently dropped, §3.4)', async () => {
  const p = await project(FEATURE);
  try {
    const d = await subtree(p, 'src/feature');
    const intl = files(d.internal);
    assert.ok(
      intl.some((f) => f.endsWith('feature/internal-user.ts')),
      `internal importer present: ${intl.join(',')}`,
    );
    // internal must NOT inflate the blocker headline
    assert.ok(
      !files(d.external).some((f) => f.endsWith('feature/internal-user.ts')),
      'internal importer is not an external blocker',
    );
  } finally {
    await p.dispose();
  }
});

test('subtree: per-row target varies (each importer pulls the SPECIFIC file under the tree, §fork4)', async () => {
  const p = await project(FEATURE);
  try {
    const d = await subtree(p, 'src/feature');
    const barrel = (d.external ?? []).find((r) => r.at.includes('usesBarrel'));
    const deep = (d.external ?? []).find((r) => r.at.includes('usesSub'));
    assert.ok(barrel?.target?.endsWith('feature/index.ts'), `barrel target: ${barrel?.target}`);
    assert.ok(deep?.target?.endsWith('feature/sub.ts'), `deep target: ${deep?.target}`);
    assert.notEqual(barrel?.target, deep?.target, 'target column varies per row');
  } finally {
    await p.dispose();
  }
});

test('subtree EXTERNAL equals the independent target-centric oracle', async () => {
  const p = await project(FEATURE);
  try {
    const sub = await subtree(p, 'src/feature');
    const external = new Set(files(sub.external));

    // Oracle: ∪ single-module importers_of over each file UNDER the subtree, minus inside-subtree importers.
    const filesUnder = [
      'src/feature/index.ts',
      'src/feature/helper.ts',
      'src/feature/sub.ts',
      'src/feature/internal-user.ts',
    ];
    const oracle = new Set<string>();
    for (const f of filesUnder) {
      const r = await p.op('importers_of', { module: f });
      assert.ok('result' in r && r.result.ok, JSON.stringify(r));
      const imp = (r.result.data as { importers?: { at: string }[] }).importers ?? [];
      for (const i of imp) {
        const file = i.at.slice(0, i.at.lastIndexOf(':'));
        if (!file.startsWith('src/feature/')) oracle.add(file); // drop inside-subtree importers
      }
    }
    assert.deepEqual([...external].sort(), [...oracle].sort(), 'external set == oracle set');
  } finally {
    await p.dispose();
  }
});

// ── Fixture B: dir/file collision — directory-wins, file arg stays module-mode (no regression) ──
test('subtree: dir/file collision — bare name → directory (subtree); `foo.ts` → module (no regress); `foo/` forces subtree', async () => {
  const p = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'src/foo.ts': 'export const fooFile = 1;\n',
    'src/foo/bar.ts': 'export const bar = 2;\n',
    'src/useFile.ts': "import { fooFile } from './foo';\nexport const a = fooFile;\n", // resolves to foo.ts
    'src/useDir.ts': "import { bar } from './foo/bar';\nexport const b = bar;\n", // pulls under foo/
  });
  try {
    const dir = await subtree(p, 'src/foo');
    assert.equal(dir.mode, 'subtree', 'bare directory name → subtree (directory-wins)');
    assert.ok(
      files(dir.external).some((f) => f.endsWith('useDir.ts')),
      'the under-foo importer is a blocker',
    );
    assert.ok(
      !files(dir.external).some((f) => f.endsWith('useFile.ts')),
      'useFile imports foo.ts (NOT under foo/) — not a subtree importer',
    );

    // file arg → module mode, unchanged behavior (regression gate)
    const fileMode = await subtree(p, 'src/foo.ts');
    assert.notEqual(fileMode.mode, 'subtree', 'an explicit file arg stays module-mode');

    // trailing slash forces subtree even though `src/foo` collides with `src/foo.ts`? (foo dir only)
    const forced = await subtree(p, 'src/foo/');
    assert.equal(forced.mode, 'subtree', 'trailing slash forces subtree');
  } finally {
    await p.dispose();
  }
});

// ── Fixture C: unresolvable spec under subtree → unconfirmed flag, NOT raw-matched ──────────────
test('subtree: an unresolvable spec lexically under the tree is FLAGGED unconfirmed, never raw-matched; not "safe"', async () => {
  const p = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'src/widget/Box.tsx': 'export const Box = 1;\n',
    'src/widget/theme.scss': '.x { color: red; }\n',
    'src/app/consumer.tsx': "import '../widget/theme.scss';\nexport const C = 2;\n", // .scss: TS can't resolve
  });
  try {
    const d = await subtree(p, 'src/widget');
    assert.equal(d.mode, 'subtree');
    assert.ok(
      (d.unconfirmed ?? []).some((u) => u.at.includes('consumer') && u.spec.includes('theme.scss')),
      `unconfirmed flag present: ${JSON.stringify(d.unconfirmed)}`,
    );
    // NOT raw-matched into confirmed sets (no false-LIVE)
    assert.ok(
      !files(d.external).some((f) => f.endsWith('consumer.tsx')),
      'unresolvable spec is NOT a confirmed external importer',
    );
    assert.equal(d.safe, false, 'unconfirmed>0 ⇒ NOT safe');
  } finally {
    await p.dispose();
  }
});

test('subtree: clean tree with one external blocker is NOT safe; a tree with zero confirmed/unconfirmed (complete) IS safe', async () => {
  // safe case: a self-contained folder nothing outside imports
  const p = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'src/dead/a.ts': "import { b } from './b';\nexport const a = b;\n", // internal only
    'src/dead/b.ts': 'export const b = 1;\n',
    'src/main.ts': 'export const m = 1;\n',
  });
  try {
    const d = await subtree(p, 'src/dead');
    assert.equal(d.blockers, 0, 'no external importers');
    assert.equal(d.complete, true, 'no undiscovered programs in this fixture');
    assert.equal(d.safe, true, 'external=0 ∧ complete ∧ unconfirmed=0 ⇒ safe');
  } finally {
    await p.dispose();
  }
});

// ── Cross-program: a sibling-(test-)program importer under the tree is found, and a src file in
//    BOTH programs dedups to one row. Exercises the `for (const p of host.programs())` merge. ─────
test('subtree spans sibling programs: a test-file importer under the tree is an external blocker; a dual-program importer dedups to one row', async () => {
  const p = await project({
    'tsconfig.json': `{"compilerOptions":${COMPILER},"include":["src"]}`,
    'tsconfig.test.json': `{"compilerOptions":${COMPILER},"include":["src","test"]}`,
    'src/feature/sub.ts': 'export const sub = 1;\n',
    'src/app/usesSub.ts': "import { sub } from '../feature/sub';\nexport const u = sub;\n", // in BOTH programs
    'test/uses.ts': "import { sub } from '../src/feature/sub';\nexport const t = sub;\n", // ONLY in the test program
  });
  try {
    const d = await subtree(p, 'src/feature');
    const ext = files(d.external);
    assert.ok(
      ext.some((f) => f.endsWith('test/uses.ts')),
      `sibling-only (test) importer is an external blocker: ${ext.join(',')}`,
    );
    // the dual-program src importer must appear exactly ONCE (resolved by both programs, deduped by `at`)
    const appRows = (d.external ?? []).filter((r) => r.at.startsWith('src/app/usesSub.ts'));
    assert.equal(
      appRows.length,
      1,
      `dual-program importer dedups to one row, got ${appRows.length}`,
    );
  } finally {
    await p.dispose();
  }
});
