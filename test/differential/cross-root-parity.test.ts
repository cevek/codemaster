// Cross-root parity (t-869370) + the cross-root × `programs:` composition (t-228533), oracle-backed
// (§16). A `root:`-targeted sibling repo spawns a FULL engine for that root, so it runs the SAME
// discovery (root tsconfig + adjacent siblings + workspace members + t-232769 stray injection) as the
// primary root — a cross-root find_usages / importers_of is therefore honest: complete WHEN it is
// complete, floored WHEN a genuinely-undiscovered nested config exists. This was the cross-root
// incompleteness dogfood entries 39/42 reported (pre-workspace-member-discovery). These pin it:
//   (6a) a cross-root no-root monorepo sibling → complete (members self-discovered), cold-LS oracle;
//   (6b) a cross-root sibling WITH an undiscovered nested config → floored honestly (not a false 0);
//   (7)  cross-root × programs: the `programs:` paths resolve against the TARGET root (the op runs in
//        that engine), recovering completeness over the sibling's own floored config.
// Oracle: a fresh-from-cold LS over the sibling's OWN member/nested config (a different program).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiRepo } from '../helpers/multi-repo.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const C = '{"strict":true,"module":"esnext","moduleResolution":"bundler"}';

type Usage = { span: { file: string; line: number; col: number }; role: string };
type UsagesData = {
  usages?: Usage[];
  complete?: boolean;
  undiscoveredPrograms?: string[];
  programsLoaded?: string[];
};
function usagesData(r: OpResult | undefined): UsagesData {
  assert.ok(r !== undefined && 'result' in r && r.result.ok, JSON.stringify(r));
  return r.result.data as UsagesData;
}
const fileSet = (u: Usage[]): string[] => [...new Set(u.map((x) => x.span.file))].sort();

test('(6a) cross-root: a no-root monorepo sibling self-discovers members → complete, matches cold oracle', async () => {
  const mr = await multiRepo({
    main: {
      'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'src/a.ts': 'export const mainSym = 1;\n',
    },
    sib: {
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'package.json': '{"name":"sibroot","private":true}',
      'packages/pkg-a/package.json': '{"name":"pkg-a"}',
      'packages/pkg-a/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'packages/pkg-a/src/index.ts': 'export const sibSym = 1;\n',
      'packages/pkg-b/package.json': '{"name":"pkg-b"}',
      'packages/pkg-b/tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'packages/pkg-b/src/use.ts':
        "import { sibSym } from '../../pkg-a/src/index';\nexport const bar = sibSym + 1;\n",
    },
  });
  try {
    const sibRoot = mr.root('sib');
    const [r] = await mr.request([
      { name: 'find_usages', args: { name: 'sibSym', collapseImports: false }, root: sibRoot },
    ]);
    const d = usagesData(r);
    assert.notEqual(
      d.complete,
      false,
      'a self-discovering monorepo sibling is complete cross-root',
    );
    assert.deepEqual(
      d.undiscoveredPrograms ?? [],
      [],
      'no floor cross-root when actually complete',
    );
    const u = d.usages ?? [];
    assert.deepEqual(fileSet(u), ['packages/pkg-a/src/index.ts', 'packages/pkg-b/src/use.ts']);
    // Oracle: cold LS over the sibling member's OWN config — the ground truth for the cross-package ref.
    const oracle = coldFindReferences(
      sibRoot,
      'packages/pkg-a/src/index.ts',
      'sibSym',
      'packages/pkg-b/tsconfig.json',
    );
    assert.deepEqual(fileSet(u), oracle, 'cross-root warm fan-out matches the sibling cold oracle');
  } finally {
    await mr.dispose();
  }
});

test('(6b) cross-root: a sibling with a genuinely-undiscovered nested config floors honestly (not a false 0)', async () => {
  const mr = await multiRepo({
    main: {
      'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'src/a.ts': 'export const mainSym = 1;\n',
    },
    sib: {
      'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'src/lib.ts': 'export const sibShared = 1;\n',
      // Undiscovered nested config in the SIBLING repo (not adjacent/referenced/member).
      'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
      'nested/app.ts': "import { sibShared } from '../src/lib';\nexport const x = sibShared;\n",
    },
  });
  try {
    const sibRoot = mr.root('sib');
    const [r] = await mr.request([
      { name: 'find_usages', args: { name: 'sibShared', collapseImports: false }, root: sibRoot },
    ]);
    const d = usagesData(r);
    assert.equal(d.complete, false, 'cross-root honestly floors on a real undiscovered config');
    assert.ok(
      (d.undiscoveredPrograms ?? []).includes('nested/tsconfig.json'),
      `the sibling's own nested config is named: ${JSON.stringify(d.undiscoveredPrograms)}`,
    );
  } finally {
    await mr.dispose();
  }
});

test('(7) cross-root × programs: paths resolve against the TARGET root and recover completeness', async () => {
  const mr = await multiRepo({
    main: {
      'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'src/a.ts': 'export const mainSym = 1;\n',
    },
    sib: {
      'tsconfig.json': `{"compilerOptions":${C},"include":["src"]}`,
      'src/lib.ts': 'export const sibShared = 1;\n',
      'nested/tsconfig.json': `{"compilerOptions":${C},"include":["."]}`,
      'nested/app.ts': "import { sibShared } from '../src/lib';\nexport const x = sibShared;\n",
    },
  });
  try {
    const sibRoot = mr.root('sib');
    // The programs: path is repo-relative to the TARGET (sib) root, since the op runs in sib's engine.
    const [r] = await mr.request([
      {
        name: 'find_usages',
        args: { name: 'sibShared', collapseImports: false, programs: ['nested/tsconfig.json'] },
        root: sibRoot,
      },
    ]);
    const d = usagesData(r);
    assert.deepEqual(
      d.programsLoaded,
      ['nested/tsconfig.json'],
      'resolved against the target root',
    );
    assert.notEqual(d.complete, false, 'floor lifts cross-root once the sibling config is loaded');
    assert.ok(
      fileSet(d.usages ?? []).includes('nested/app.ts'),
      `the sibling nested usage is found cross-root: ${JSON.stringify(d.usages)}`,
    );
    const oracle = coldFindReferences(sibRoot, 'src/lib.ts', 'sibShared', 'nested/tsconfig.json');
    assert.deepEqual(
      fileSet(d.usages ?? []),
      oracle,
      'cross-root+lever matches the sibling oracle',
    );
  } finally {
    await mr.dispose();
  }
});
