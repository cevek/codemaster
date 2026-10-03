// The drift fence refuses a write only for working-tree changes the §2.8 gate's verdict rests on
// (t-500739): files of the checked programs (owned or glob-claimable), program-reshaping files,
// deletions, and touched paths. Each test drives the real op and edits the tree right after `gateAcross`;
// oracles are the bytes on disk and `git status`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { project, type ProjectOptions } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { OpRequest } from '../../src/ops/contracts.ts';

type Proj = Awaited<ReturnType<typeof project>>;
type Data = Record<string, JsonValue>;

async function run(p: Proj, req: OpRequest): Promise<Data> {
  const [r] = await p.request([req]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result)}`);
  return r.result.data as Data;
}

const MOVE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/util.ts': 'export function twice(n: number): number {\n  return n * 2;\n}\n',
  'src/use.ts': "import { twice } from './util';\nexport const four = twice(2);\n",
};
const MOVE_REQ: OpRequest = {
  name: 'move_file',
  args: { source: 'src/util.ts', dest: 'src/lib/util.ts' },
  apply: true,
};

/** Run `during(root)` right after the gate verified the tree — after the entry capture, before the
 *  pre-write one, and without the gate itself seeing the change. */
function duringGate(during: (root: string, write: (rel: string, c: string) => void) => void) {
  let root = '';
  const options: ProjectOptions = {
    patchTs(api, { write }) {
      const gate = api.gateAcross.bind(api);
      api.gateAcross = (files, scope, deadline) => {
        const out = gate(files, scope, deadline);
        during(root, write);
        return out;
      };
    },
  };
  return { options, setRoot: (r: string) => (root = r) };
}

test('a file outside every program edited after the gate does not refuse the write', async () => {
  const h = duringGate((_root, write) => {
    write('scripts/tool.ts', 'export const tool: number = 1;\n');
    write('package-lock.json', '{"lockfileVersion":3}\n');
  });
  const p = await project(MOVE, h.options);
  h.setRoot(p.root);
  try {
    const data = await run(p, MOVE_REQ);
    assert.equal(data['applied'], true, JSON.stringify(data));
    assert.ok(existsSync(path.join(p.root, 'src/lib/util.ts')), 'the move landed');
  } finally {
    await p.dispose();
  }
});

// Not a regression pin: a NEW file under the program's glob is not yet in the program, so only the
// glob claim (`mayContain`) vouches for it — `containsFile` alone would let it through.
test('a new file under a program glob created after the gate refuses the write', async () => {
  const h = duringGate((_root, write) => write('src/late.ts', 'export const late = 1;\n'));
  const p = await project(MOVE, h.options);
  h.setRoot(p.root);
  try {
    const data = await run(p, MOVE_REQ);
    assert.equal(data['mode'], 'dry-run', JSON.stringify(data));
    assert.match(String(data['reason']), /working tree changed.*src\/late\.ts/);
    assert.ok(existsSync(path.join(p.root, 'src/util.ts')), 'nothing written');
  } finally {
    await p.dispose();
  }
});

// An import-only file (outside `include`) leaves every program once deleted, so membership cannot
// vouch for it — the deletion alone must refuse. A tracked file's deletion stays in porcelain (` D`);
// an untracked one's leaves it entirely.
for (const tracked of [true, false]) {
  test(`deleting an import-only ${tracked ? 'tracked' : 'untracked'} file after the gate refuses the write`, async () => {
    const h = duringGate((root) => rmSync(path.join(root, 'lib/helper.ts')));
    const helper = { 'lib/helper.ts': 'export const helper = 1;\n' };
    const p = await project(
      {
        ...MOVE,
        ...(tracked ? helper : {}),
        'src/use.ts':
          "import { twice } from './util';\nimport { helper } from '../lib/helper';\nexport const four = twice(helper);\n",
      },
      h.options,
    );
    h.setRoot(p.root);
    if (!tracked) p.write('lib/helper.ts', helper['lib/helper.ts']);
    try {
      const data = await run(p, MOVE_REQ);
      assert.equal(data['mode'], 'dry-run', JSON.stringify(data));
      assert.match(String(data['reason']), /working tree changed.*lib\/helper\.ts/);
    } finally {
      await p.dispose();
    }
  });
}

test('an extends target with a non-tsconfig name edited after the gate refuses the write', async () => {
  const h = duringGate((_root, write) =>
    write('configs/base.json', '{"compilerOptions":{"strict":true,"noUnusedLocals":true}}\n'),
  );
  const p = await project(
    {
      ...MOVE,
      'configs/base.json': '{"compilerOptions":{"strict":true}}\n',
      'tsconfig.json': '{"extends":"./configs/base.json","include":["src"]}',
    },
    h.options,
  );
  h.setRoot(p.root);
  try {
    const data = await run(p, MOVE_REQ);
    assert.equal(data['mode'], 'dry-run', JSON.stringify(data));
    assert.match(String(data['reason']), /working tree changed.*configs\/base\.json/);
  } finally {
    await p.dispose();
  }
});

// Workspace root = `pkg/`, a program file lives outside it and is ALREADY dirty: only a content hash
// of the right path sees a second edit (porcelain reads ` M` both times).
test('subdirectory root: re-editing a dirty program file outside the root refuses the write', async () => {
  const h = duringGate((_root, write) => write('../shared/x.ts', 'export const x: number = 3;\n'));
  const p = await project(
    {
      'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src","../shared"]}',
      'src/util.ts': MOVE['src/util.ts'],
      'src/use.ts': MOVE['src/use.ts'],
      '../shared/x.ts': 'export const x: number = 1;\n',
    },
    { ...h.options, subdir: 'pkg' },
  );
  h.setRoot(p.root);
  try {
    p.write('../shared/x.ts', 'export const x: number = 2;\n');
    const data = await run(p, MOVE_REQ);
    assert.equal(data['mode'], 'dry-run', JSON.stringify(data));
    assert.match(String(data['reason']), /working tree changed.*\.\.\/shared\/x\.ts/);
    assert.match(readFileSync(path.join(p.root, 'src/util.ts'), 'utf8'), /twice/, 'nothing moved');
  } finally {
    await p.dispose();
  }
});
