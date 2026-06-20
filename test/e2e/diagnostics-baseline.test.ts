// The §2.8 gate diffs post-edit diagnostics against a PRE-EDIT baseline, so a repo's
// pre-existing (unrelated) errors never block — or bury — an edit. This pins the whole-program
// scope path (codemod widens to it), where the old "any diagnostic refuses" behavior made the
// op unusable on any real repo that doesn't fully compile, and dumped the whole repo's errors.
//
// Oracles, independent of the warm LS: the on-disk bytes after apply, and a cold tsc (here we
// assert the gate's decision + that the introduced/pre-existing split is honest).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const TSCONFIG = '{"compilerOptions":{"strict":true,"module":"preserve"}}';

type Envelope = {
  applied?: boolean;
  reason?: string;
  typecheck: {
    clean: boolean;
    introduced?: { file: string; message: string }[];
    preExisting?: number;
  };
};
type Proj = Awaited<ReturnType<typeof project>>;

async function codemod(p: Proj, args: JsonValue, apply = false): Promise<Envelope> {
  const [r] = await p.request([{ name: 'codemod', args, ...(apply ? { apply: true } : {}) }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as Envelope;
}

// A sound, whole-program-scoped edit must apply even though the repo carries an UNRELATED
// pre-existing error — the gate refuses on what the EDIT introduces, not on the repo's state.
test('codemod (whole-program scope): applies despite an unrelated pre-existing error', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export const oldApi = (n: number): number => n;\nexport const newApi = (n: number): number => n;\n',
    'src/use.ts':
      "import { oldApi, newApi } from './api';\nexport const a = oldApi(1);\nvoid newApi;\n",
    'src/broken.ts': "export const bad: number = 'not a number';\n", // pre-existing, unrelated
  });
  try {
    const env = await codemod(p, { pattern: 'oldApi($A)', rewrite: 'newApi($A)' }, true);
    assert.equal(env.typecheck.clean, true, 'no NEW errors introduced → clean');
    assert.equal(env.applied, true, 'not blocked by the unrelated pre-existing error');
    assert.equal(env.typecheck.preExisting, 1, 'the unrelated error is counted, not dumped');
    assert.match(readFileSync(path.join(p.root, 'src/use.ts'), 'utf8'), /newApi\(1\)/);
  } finally {
    await p.dispose();
  }
});

// When the edit DOES introduce an error, the gate still refuses — and reports the introduced
// error, with the pre-existing one kept as a separate count (never conflated, never dumped).
test('codemod: an edit that introduces an error is refused; introduced vs pre-existing split', async () => {
  const p = await project({
    'tsconfig.json': TSCONFIG,
    'src/api.ts':
      'export const oldApi = (n: number): number => n;\nexport const newApi = (n: number): number => n;\n',
    'src/use.ts':
      "import { oldApi, newApi } from './api';\nexport const a = oldApi(1);\nvoid newApi;\n",
    'src/broken.ts': "export const bad: number = 'not a number';\n",
  });
  try {
    // Rewrite to a 2-arg call of a 1-arg function → a NEW type error the edit caused.
    const env = await codemod(p, { pattern: 'oldApi($A)', rewrite: 'newApi($A, $A)' }, true);
    assert.equal(env.typecheck.clean, false);
    assert.notEqual(env.applied, true);
    assert.match(String(env.reason), /apply refused/);
    const introduced = env.typecheck.introduced ?? [];
    assert.ok(
      introduced.some((d) => d.file === 'src/use.ts'),
      `expected an introduced error in use.ts, got ${JSON.stringify(introduced)}`,
    );
    assert.ok(
      !introduced.some((d) => d.file === 'src/broken.ts'),
      'the pre-existing error must NOT appear as introduced',
    );
    assert.equal(env.typecheck.preExisting, 1, 'pre-existing error stays a count');
    assert.equal(p.git('status', '--porcelain'), ''); // zero writes
  } finally {
    await p.dispose();
  }
});
