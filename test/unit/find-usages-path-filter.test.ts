// t-019044 sub-bug + t-310874 at the op level: `find_usages`' path filter used a RAW matcher, so a
// bare-dir `pathExclude` silently no-op'd (byte-identical to unfiltered — the reported sub-bug) and a
// literal special-char dir had no working incantation. Oracle: the explicit `dir/**` glob — the bare
// dir and the special-char dir must filter the SAME sites, never zero.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { findUsagesOp } from '../../src/ops/find-usages.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/widget.ts': 'export function Widget() { return 1; }\n',
  'src/app.ts': 'import { Widget } from "./widget"; export const a = Widget();\n',
  'src/feature/use.ts': 'import { Widget } from "../widget"; export const b = Widget();\n',
  'src/(auth)/page.ts': 'import { Widget } from "../widget"; export const c = Widget();\n',
};

function usageFiles(r: OpResult): { total: number; files: string[] } {
  assert.ok('result' in r && r.result.ok, `expected success, got ${JSON.stringify(r)}`);
  const d = r.result.data as { total: number; usages?: { span?: { file?: string } }[] };
  return { total: d.total, files: (d.usages ?? []).map((u) => u.span?.file ?? '') };
}

test('bare-dir pathExclude on find_usages now filters (was a silent no-op — the sub-bug)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const bare = usageFiles(
      await p.op('find_usages', {
        file: 'src/widget.ts',
        line: 1,
        col: 17,
        filter: { pathExclude: ['src/feature'] },
      }),
    );
    const glob = usageFiles(
      await p.op('find_usages', {
        file: 'src/widget.ts',
        line: 1,
        col: 17,
        filter: { pathExclude: ['src/feature/**'] },
      }),
    );
    assert.equal(bare.total, glob.total, 'bare `src/feature` filters the SAME as `src/feature/**`');
    assert.ok(
      !bare.files.some((f) => f.startsWith('src/feature/')),
      'no src/feature/ usage survives the bare-dir exclude',
    );
  } finally {
    await p.dispose();
  }
});

test('t-051337: empty pathInclude/pathExclude array is rejected by the schema (no silent zero usages)', () => {
  // Before: `find_usages`' filter arrays lacked `.min(1)` (search_symbol/list HAD it), and the raw
  // per-site gate treated a defined-empty `pathInclude:[]` as EXCLUDE-EVERYTHING (matchesAnyGlob(f,
  // []) === false → every ref dropped) → `usages:[]` read as "no usages" — a latent silent lie.
  // Now `.min(1)` fails the meaningless-empty intent fast, parity with search_symbol.
  assert.equal(
    findUsagesOp.argsSchema.safeParse({ name: 'X', filter: { pathInclude: [] } }).success,
    false,
    'empty pathInclude rejected',
  );
  assert.equal(
    findUsagesOp.argsSchema.safeParse({ name: 'X', filter: { pathExclude: [] } }).success,
    false,
    'empty pathExclude rejected',
  );
  // A non-empty array (and an omitted filter) is accepted — the fix only rejects empty.
  assert.equal(
    findUsagesOp.argsSchema.safeParse({ name: 'X', filter: { pathInclude: ['src/**'] } }).success,
    true,
  );
  assert.equal(findUsagesOp.argsSchema.safeParse({ name: 'X' }).success, true);
});

test('literal special-char dir works as a find_usages path filter (t-310874)', async () => {
  const p: TestProject = await project(FILES);
  try {
    const incl = usageFiles(
      await p.op('find_usages', {
        file: 'src/widget.ts',
        line: 1,
        col: 17,
        filter: { pathInclude: ['src/(auth)'] },
      }),
    );
    assert.ok(incl.total > 0, 'the (auth) route-group dir must be a usable include filter');
    assert.ok(
      incl.files.every((f) => f.startsWith('src/(auth)/') || f === 'src/widget.ts'),
      'only src/(auth)/ usages (and the decl) survive the include',
    );
  } finally {
    await p.dispose();
  }
});
