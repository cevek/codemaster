// `impact_type_error` against the real Language Service, cross-checked by an INDEPENDENT cold
// `ts.Program` compiled with the SAME trial edit (`coldDiagnosticFilesWithEdit`). The discriminating
// case is the spec's done-definition: a `replace` that makes a field required must report the
// CONSTRUCTING dependent broken (really red after the edit) and the READING dependent clean (green)
// — a red→green discrimination no grep/golden could give. The oracle is a different TS view (cold,
// whole-program) than the op's warm overlay, so the agreement is real, not the checker against
// itself (§16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldDiagnosticFilesWithEdit } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type TypeErrorData = {
  target: { id: string; name: string; kind: string };
  simulated: string;
  verdict: {
    dependents: number;
    filesChecked: number;
    brokenFiles: number;
    editSiteBroke: boolean;
    downstreamTrusted: boolean;
    clean: boolean;
  };
  notes?: string[];
  brokenBy?: string[];
};

function dataOf(r: OpResult): TypeErrorData {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as TypeErrorData;
}

test('replace making a field required: the CONSTRUCTOR dependent breaks, the READER stays clean', async () => {
  const AFTER = 'export interface Model { a: number; b: number; }\n';
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/model.ts': 'export interface Model { a: number; }\n',
    // Constructs a Model literal — must go RED when `b` becomes required.
    'src/ctor.ts':
      "import type { Model } from './model';\nexport const make = (): Model => ({ a: 1 });\n",
    // Only READS `m.a` — type-compatible with the wider Model, must stay GREEN.
    'src/reader.ts':
      "import type { Model } from './model';\nexport const read = (m: Model): number => m.a;\n",
  });
  try {
    const d = dataOf(
      await p.op('impact_type_error', {
        name: 'Model',
        edit: { replace: 'export interface Model { a: number; b: number; }' },
      }),
    );
    assert.equal(d.target.name, 'Model');
    assert.equal(d.simulated, 'replace declaration');

    // Independent oracle: a cold whole-program compile of the SAME after-state.
    const oracle = coldDiagnosticFilesWithEdit(p.root, 'src/model.ts', AFTER).filter(
      (f) => f !== 'src/model.ts',
    );
    assert.deepEqual(oracle, ['src/ctor.ts'], 'oracle: only the constructor file is really red');

    assert.equal(d.verdict.clean, false, 'the edit breaks something — not clean');
    assert.deepEqual(
      (d.brokenBy ?? []).slice().sort(),
      ['src/ctor.ts'],
      'op agrees with the cold oracle: ctor broke, reader did NOT (red→green discrimination)',
    );
    assert.ok(
      !(d.brokenBy ?? []).includes('src/reader.ts'),
      'the type-compatible reader is never falsely reported broken',
    );
    assert.ok(d.verdict.dependents >= 2, 'both dependents are in the closure scope (not vacuous)');
  } finally {
    await p.dispose();
  }
});

test('remove: deleting a symbol breaks its referencer (sugar for an empty replacement)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/util.ts': 'export const util = (): number => 1;\n',
    'src/caller.ts': "import { util } from './util';\nexport const call = (): number => util();\n",
  });
  try {
    const d = dataOf(await p.op('impact_type_error', { name: 'util', edit: { remove: true } }));
    assert.equal(d.simulated, 'remove declaration');

    const oracle = coldDiagnosticFilesWithEdit(p.root, 'src/util.ts', '').filter(
      (f) => f !== 'src/util.ts',
    );
    assert.deepEqual(
      oracle,
      ['src/caller.ts'],
      'oracle: the referencer goes red when util is gone',
    );

    assert.equal(d.verdict.clean, false);
    assert.deepEqual((d.brokenBy ?? []).slice().sort(), ['src/caller.ts']);
  } finally {
    await p.dispose();
  }
});

test('cross-program: a dependent living ONLY in a sibling tsconfig (test/**) is checked, not silently clean', async () => {
  // The headline claim (anchor = target ∪ deps fans the typecheck across sibling programs): the
  // primary tsconfig compiles only src/**, so `m` (which constructs a Model) lives ONLY in the
  // tsconfig.test.json program. Making `b` required must report test/use.test.ts broken — a
  // test-only dependent the primary program never compiles, never falsely reported clean (§3.4).
  const AFTER = 'export interface Model { a: number; b: number; }\n';
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
    'tsconfig.test.json': '{"compilerOptions":{"strict":true},"include":["src","test"]}',
    'src/model.ts': 'export interface Model { a: number; }\n',
    'test/use.test.ts':
      "import type { Model } from '../src/model';\nexport const m: Model = { a: 1 };\n",
  });
  try {
    const d = dataOf(
      await p.op('impact_type_error', {
        name: 'Model',
        edit: { replace: 'export interface Model { a: number; b: number; }' },
      }),
    );
    // Independent oracle: the cold TEST program (the only one that compiles test/**) with the edit.
    const oracle = coldDiagnosticFilesWithEdit(
      p.root,
      'src/model.ts',
      AFTER,
      'tsconfig.test.json',
    ).filter((f) => f !== 'src/model.ts');
    assert.deepEqual(oracle, ['test/use.test.ts'], 'oracle: the test-only dependent is really red');

    assert.equal(d.verdict.clean, false, 'a sibling-program break is NOT reported clean');
    assert.deepEqual(
      (d.brokenBy ?? []).slice().sort(),
      ['test/use.test.ts'],
      'the test-only dependent is checked across programs and reported broken',
    );
  } finally {
    await p.dispose();
  }
});

test('a type-compatible change introduces NO errors — honest clean, not a vacuous one', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/model.ts': 'export interface Model { a: number; }\n',
    'src/reader.ts':
      "import type { Model } from './model';\nexport const read = (m: Model): number => m.a;\n",
  });
  try {
    const d = dataOf(
      await p.op('impact_type_error', {
        // Adding an OPTIONAL field is backward-compatible — the reader still compiles.
        name: 'Model',
        edit: { replace: 'export interface Model { a: number; c?: number; }' },
      }),
    );
    const oracle = coldDiagnosticFilesWithEdit(
      p.root,
      'src/model.ts',
      'export interface Model { a: number; c?: number; }\n',
    );
    assert.deepEqual(oracle, [], 'oracle: nothing breaks under a backward-compatible change');

    assert.equal(d.verdict.clean, true, 'no introduced errors → clean');
    assert.equal(d.verdict.brokenFiles, 0);
    assert.ok(d.brokenBy === undefined, 'no broken-file listing when nothing broke');
    assert.ok(
      d.verdict.dependents >= 1,
      'clean is over a REAL dependent (the reader), not an empty closure',
    );

    // A no-op replace (the SAME declaration text) splices identical content → empty introduced set,
    // an honest clean, never a throw.
    const same = dataOf(
      await p.op('impact_type_error', {
        name: 'Model',
        edit: { replace: 'export interface Model { a: number; }' },
      }),
    );
    assert.equal(same.verdict.clean, true, 'replacing a decl with its own text introduces nothing');
  } finally {
    await p.dispose();
  }
});

test('ill-formed {replace}: edit-site errors are flagged `!!` — downstream is not silently sold as blast radius', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/model.ts': 'export interface Model { a: number; }\n',
    'src/reader.ts':
      "import type { Model } from './model';\nexport const read = (m: Model): number => m.a;\n",
  });
  try {
    const d = dataOf(
      await p.op('impact_type_error', {
        // Syntactically broken: a missing closing brace — a parse error in the edited file ITSELF.
        name: 'Model',
        edit: { replace: 'export interface Model { a: number;' },
      }),
    );
    assert.ok(
      (d.notes ?? []).some((n) => n.includes('!!') && n.includes('src/model.ts')),
      'the edit-site error is flagged `!!` so the downstream is not trusted as a true blast radius',
    );
  } finally {
    await p.dispose();
  }
});

test('edit collapsing the edited symbol to `any` masks a downstream break — downstreamTrusted:false separates it from a genuine clean', async () => {
  // The masking (t-993754): a trial edit that degrades the EDITED symbol's own inferred type to
  // `any` (here via an intra-file error — the zod-superRefine cascade shape) makes the dependents
  // see `any`, so their would-be breaks stop erroring and `brokenFiles` under-counts. The discriminating
  // pair: the SAME downstream dependency, one edit genuinely breaks it (CONTROL), one masks it (COLLAPSE)
  // — only `downstreamTrusted` tells them apart, so brokenFiles=0 under a collapse is never sold as clean.
  const files = {
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/model.ts': 'export const model = { a: 1 };\n',
    // Reads `model.a` as a number — baseline clean; goes RED iff `a` is really retyped to a string.
    'src/reader.ts': "import { model } from './model';\nexport const r: number = model.a;\n",
  };

  const control = await project(files);
  try {
    const d = dataOf(
      await control.op('impact_type_error', {
        // Well-formed precise retype: model.a becomes a string → the reader genuinely breaks.
        name: 'model',
        edit: { replace: "export const model = { a: 'x' };" },
      }),
    );
    const oracle = coldDiagnosticFilesWithEdit(
      control.root,
      'src/model.ts',
      "export const model = { a: 'x' };\n",
    ).filter((f) => f !== 'src/model.ts');
    assert.deepEqual(
      oracle,
      ['src/reader.ts'],
      'oracle: the precise retype really breaks the reader',
    );

    assert.equal(d.verdict.editSiteBroke, false, 'a well-formed edit does not break the edit site');
    assert.equal(
      d.verdict.downstreamTrusted,
      true,
      'a well-formed edit → the downstream count is trustworthy',
    );
    assert.equal(d.verdict.brokenFiles, 1, 'the genuine downstream break is reported');
    assert.deepEqual((d.brokenBy ?? []).slice().sort(), ['src/reader.ts']);
  } finally {
    await control.dispose();
  }

  const collapse = await project(files);
  try {
    const d = dataOf(
      await collapse.op('impact_type_error', {
        // Collapses `model` to `any` via an intra-file error (undefined name) — the reader now sees
        // `any` and its break is MASKED. Same downstream dependency as CONTROL.
        name: 'model',
        edit: { replace: 'export const model = JSON.parse(rawUnknown);' },
      }),
    );
    // The op faithfully reflects tsc — the cold oracle ALSO shows the reader clean (masked). So the
    // honesty cannot come from the diagnostics diff; it must come from the verdict flag.
    const oracle = coldDiagnosticFilesWithEdit(
      collapse.root,
      'src/model.ts',
      'export const model = JSON.parse(rawUnknown);\n',
    ).filter((f) => f !== 'src/model.ts');
    assert.deepEqual(
      oracle,
      [],
      'oracle: the reader break is MASKED — tsc reports 0 downstream errors',
    );

    assert.equal(
      d.verdict.brokenFiles,
      0,
      'the masked downstream break does not surface as an error',
    );
    assert.equal(d.verdict.editSiteBroke, true, 'the collapse broke the edited file itself');
    assert.equal(
      d.verdict.downstreamTrusted,
      false,
      'brokenFiles=0 under a collapse is flagged UNTRUSTWORTHY, never sold as a clean downstream',
    );
    assert.equal(d.verdict.clean, false, 'the edit-site error keeps the whole verdict non-clean');
    assert.ok(
      (d.notes ?? []).some((n) => n.includes('!!') && /LOWER BOUND|UNTRUSTWORTHY/.test(n)),
      'a loud `!!` note explains brokenFiles is a lower bound, not a clean downstream',
    );
  } finally {
    await collapse.dispose();
  }
});

test('never-hang: the dependent set is node-capped; a small nodes: bound truncates the typecheck scope with `!!`', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/model.ts': 'export interface Model { a: number; }\n',
    'src/ctor.ts':
      "import type { Model } from './model';\nexport const make = (): Model => ({ a: 1 });\n",
    'src/reader.ts':
      "import type { Model } from './model';\nexport const read = (m: Model): number => m.a;\n",
  });
  try {
    const d = dataOf(
      await p.op('impact_type_error', {
        name: 'Model',
        edit: { replace: 'export interface Model { a: number; b: number; }' },
        nodes: 1, // force the cap: only 1 dependent reachable, the scope is bounded + flagged
      }),
    );
    assert.ok(d.verdict.dependents <= 1, 'the node cap bounds the dependent set (never-hang)');
    assert.ok(
      (d.notes ?? []).some((n) => n.includes('!!') && /cap/.test(n)),
      'a capped (incomplete) typecheck scope is flagged `!!`, never read as complete-clean',
    );
  } finally {
    await p.dispose();
  }
});
