// The write side of the §2.8 contract (t-439159). The overlay gate verifies the post-edit bytes
// before the write; after it, only proven damage may roll the edit back. Each test drives the real
// op through the engine against a real git fixture and reaches its timing by wrapping the real ts
// plugin method (`patchTs`). Oracles: the bytes on disk and `git status`, never the envelope alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { project, type ProjectOptions } from '../helpers/project.ts';
import type { JsonValue } from '../../src/core/json.ts';
import type { OpRequest } from '../../src/ops/contracts.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

type Proj = Awaited<ReturnType<typeof project>>;
type Data = Record<string, JsonValue>;

async function run(p: Proj, req: OpRequest): Promise<Data> {
  const [r] = await p.request([req]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r.result)}`);
  return r.result.data as Data;
}

const read = (p: Proj, rel: string): string => readFileSync(path.join(p.root, rel), 'utf8');

const RENAME = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/def.ts': 'export const widget = 1;\n',
  'src/a.ts': "import { widget } from './def';\nexport const a = widget + 1;\n",
};
const RENAME_REQ: OpRequest = {
  name: 'rename_symbol',
  args: { name: 'widget', newName: 'gadget' },
  apply: true,
};

const MOVE = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/util.ts': 'export function twice(n: number): number {\n  return n * 2;\n}\n',
  'src/use.ts': "import { twice } from './util';\nexport const four = twice(2);\n",
  'src/other.ts': 'export const unrelated: number = 3;\n',
};
const MOVE_REQ: OpRequest = {
  name: 'move_file',
  args: { source: 'src/util.ts', dest: 'src/lib/util.ts' },
  apply: true,
};

/** Budget spent right after the post-write reindex → the recheck is never started. */
const expireAfterReindex: ProjectOptions = {
  opDeadlineMs: 60_000,
  patchTs(api, { clock }) {
    const reindex = api.reindex.bind(api);
    api.reindex = async (paths) => {
      await reindex(paths);
      // Only the op's post-write reindex — never the engine's entry refresh.
      if (paths.includes('src/def.ts' as RepoRelPath)) clock.advance(120_000);
    };
  },
};

/** Budget spent just before the recheck's LS call → the real `withDeadline` cancels it inside the
 *  checker (the fixture's function body is a node the checker polls on). */
const expireInsideRecheck: ProjectOptions = {
  opDeadlineMs: 60_000,
  patchTs(api, { clock }) {
    const divergence = api.claimDivergence.bind(api);
    api.claimDivergence = (claims, restrictTo) => {
      const out = divergence(claims, restrictTo);
      clock.advance(120_000);
      return out;
    };
  },
};

for (const [label, files, req, written, options, why] of [
  ['rename_symbol', RENAME, RENAME_REQ, 'src/def.ts', expireAfterReindex, /expired before/],
  ['move_file', MOVE, MOVE_REQ, 'src/lib/util.ts', expireInsideRecheck, /expired during/],
] as const) {
  test(`${label}: deadline expiring after the write keeps the verified edit, says the recheck is incomplete`, async () => {
    const p = await project(files, options);
    try {
      const before = p.git('status', '--porcelain');
      assert.equal(before, '');
      const data = await run(p, req);
      assert.equal(data['applied'], true, JSON.stringify(data));
      assert.deepEqual(data['rollback'], { performed: false });
      const postApply = data['postApply'] as Data | undefined;
      assert.equal(postApply?.['complete'], false, 'the unfinished recheck is disclosed');
      assert.match(String(postApply?.['reason']), why);
      assert.ok(existsSync(path.join(p.root, written)), 'the edit stayed on disk');
      assert.notEqual(p.git('status', '--porcelain'), '', 'nothing was reverted');
    } finally {
      await p.dispose();
    }
  });
}

test('rename_symbol: a reindex throw after the write is incomplete, not a rollback', async () => {
  const p = await project(RENAME, {
    patchTs(api) {
      const reindex = api.reindex.bind(api);
      let writes = 0;
      api.reindex = async (paths) => {
        await reindex(paths);
        // The engine's own entry refresh reindexes too; fail only the op's post-write call.
        if (paths.includes('src/def.ts' as RepoRelPath) && ++writes === 1) {
          throw new Error('injected reindex fault');
        }
      };
    },
  });
  try {
    const data = await run(p, RENAME_REQ);
    assert.equal(data['applied'], true);
    assert.match(String((data['postApply'] as Data)['reason']), /reindex/);
    assert.match(read(p, 'src/def.ts'), /gadget/);
  } finally {
    await p.dispose();
  }
});

// The pre-write before-bytes check compares raw disk text with the plan's `before`; a BOM or CRLF
// file must still apply — and keep its BOM.
test('rename_symbol: a BOM + CRLF file applies and keeps its BOM', async () => {
  const p = await project({
    ...RENAME,
    'src/def.ts': '﻿export const widget = 1;\r\n',
  });
  try {
    const data = await run(p, RENAME_REQ);
    assert.equal(data['applied'], true, JSON.stringify(data));
    assert.equal(data['postApply'], undefined);
    const def = read(p, 'src/def.ts');
    assert.ok(def.startsWith('﻿'), 'BOM kept');
    assert.match(def, /gadget/);
  } finally {
    await p.dispose();
  }
});

test('move_file: an unrelated file edited during the gate refuses the write — nothing written', async () => {
  const p = await project(MOVE, {
    patchTs(api, { write }) {
      const gate = api.gateAcross.bind(api);
      api.gateAcross = (files, scope, deadline) => {
        write('src/other.ts', 'export const unrelated: string = "changed";\n');
        return gate(files, scope, deadline);
      };
    },
  });
  try {
    const data = await run(p, MOVE_REQ);
    assert.equal(data['mode'], 'dry-run');
    assert.match(String(data['reason']), /working tree changed.*src\/other\.ts/);
    assert.equal(p.git('status', '--porcelain').trim(), 'M src/other.ts', 'only the foreign edit');
  } finally {
    await p.dispose();
  }
});

test('rename_symbol dirtyOk: a touched file changed after planning is not overwritten', async () => {
  const p = await project(RENAME, {
    patchTs(api, { write }) {
      const plan = api.renameSites.bind(api);
      api.renameSites = (...args) => {
        const out = plan(...args);
        write('src/a.ts', "import { widget } from './def';\nexport const a = widget + 100;\n");
        return out;
      };
    },
  });
  try {
    const data = await run(p, {
      ...RENAME_REQ,
      args: { name: 'widget', newName: 'gadget', dirtyOk: true },
    });
    assert.equal(data['mode'], 'dry-run');
    assert.match(String(data['reason']), /changed on disk after the edit was planned.*src\/a\.ts/);
    assert.match(read(p, 'src/a.ts'), /widget \+ 100/, 'the foreign edit survived');
    assert.match(read(p, 'src/def.ts'), /widget = 1/, 'nothing written');
  } finally {
    await p.dispose();
  }
});

test('move_file: the post-write recheck covers the written files, not the whole program', async () => {
  const checks: string[][] = [];
  const p = await project(MOVE, {
    patchTs(api) {
      const diag = api.diagnosticsAcross.bind(api);
      api.diagnosticsAcross = (scope, restrictTo, deadline) => {
        checks.push(scope.check.map(String).sort());
        return diag(scope, restrictTo, deadline);
      };
    },
  });
  try {
    const data = await run(p, MOVE_REQ);
    assert.equal(data['applied'], true, JSON.stringify(data));
    assert.equal(data['postApply'], undefined, 'a verified write adds no postApply field');
    assert.deepEqual(checks, [['src/lib/util.ts', 'src/use.ts']]);
  } finally {
    await p.dispose();
  }
});

// The overlay force-adds an unowned dest as a primary ROOT; on disk an orphan outside every
// `include` is in no program. Its `declare global` reaches `use.ts` in the overlay but not on disk —
// a break in an UNWRITTEN file that only the widened recheck can see.
test('move_file: a membership divergence widens the recheck and rolls back the proven break', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
    'src/globals.ts': 'declare global {\n  var APP_NAME: string;\n}\nexport {};\n',
    'src/use.ts': 'export const name: string = globalThis.APP_NAME;\n',
  });
  try {
    const data = await run(p, {
      name: 'move_file',
      args: { source: 'src/globals.ts', dest: 'out/globals.ts' },
      apply: true,
    });
    assert.equal(data['applied'], false, JSON.stringify(data));
    assert.equal((data['rollback'] as Data)['performed'], true);
    assert.ok(existsSync(path.join(p.root, 'src/globals.ts')), 'restored');
    assert.ok(!existsSync(path.join(p.root, 'out/globals.ts')), 'dest removed');
  } finally {
    await p.dispose();
  }
});
