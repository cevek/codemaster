// The post-apply recheck chains from the builder state of the gate that verified the bytes it reads
// back (program-gate-builder.ts `gatedBy`): it finds that state by checking that every overlay entry
// and tombstone of the gate is among what the op wrote and removed. This pins the producer side of
// that contract on the real ops — if an op wrote different bytes than it gated (formatting applied
// after the gate, a path renamed between the two), the lookup would silently miss and every next
// gate would pay the written files' closure again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpRequest } from '../../src/ops/contracts.ts';
import type { WrittenEdit } from '../../src/plugins/ts/program-gate.ts';
import type { RepoRelPath } from '../../src/core/brands.ts';

const FILES = {
  'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["src"]}',
  'src/util.ts': 'export function twice(n: number): number {\n  return n * 2;\n}\n',
  'src/use.ts': "import { twice } from './util';\nexport const four = twice(2);\n",
  'src/lib.ts': 'export const unrelated: number = 3;\n',
};

const CASES: [string, OpRequest][] = [
  [
    'move_file',
    { name: 'move_file', args: { source: 'src/util.ts', dest: 'src/lib/util.ts' }, apply: true },
  ],
  [
    'move_symbol',
    { name: 'move_symbol', args: { name: 'twice', dest: 'src/lib.ts' }, apply: true },
  ],
  [
    'extract_symbol',
    { name: 'extract_symbol', args: { name: 'twice', dest: 'src/twice.ts' }, apply: true },
  ],
];

for (const [label, req] of CASES) {
  test(`${label}: what the gate verified is contained in what post-apply is told was written`, async () => {
    const gated: { files: { path: string; content: string }[]; removed: readonly RepoRelPath[] }[] =
      [];
    const written: WrittenEdit[] = [];
    const p = await project(FILES, {
      patchTs(api) {
        const gate = api.gateAcross.bind(api);
        api.gateAcross = (files, scope, deadline) => {
          gated.push({ files: [...files], removed: scope.removed ?? [] });
          return gate(files, scope, deadline);
        };
        const disk = api.diagnosticsAcross.bind(api);
        api.diagnosticsAcross = (scope, restrictTo, deadline, w) => {
          if (w !== undefined) written.push(w);
          return disk(scope, restrictTo, deadline, w);
        };
      },
    });
    try {
      const [r] = await p.request([req]);
      assert.ok(r !== undefined && !('error' in r) && r.result.ok, JSON.stringify(r));
      assert.equal(gated.length, 1, 'one gate');
      assert.equal(written.length, 1, 'post-apply was told what was written');
      const [g] = gated;
      const [w] = written;
      assert.ok(g !== undefined && w !== undefined && g.files.length > 0);
      const wrote = new Map(w.files.map((f) => [String(f.path), f.content]));
      for (const f of g.files) {
        assert.equal(
          wrote.get(String(f.path)),
          f.content,
          `${f.path}: written bytes == gated bytes`,
        );
      }
      for (const r of g.removed)
        assert.ok(w.removed.includes(r), `${r}: gated tombstone was removed`);
    } finally {
      await p.dispose();
    }
  });
}
