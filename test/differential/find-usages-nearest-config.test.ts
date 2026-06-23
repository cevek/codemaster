// §5-L2 read-path completeness + §3.4 floor for find_usages / importers_of (the loose-root-monorepo
// fatal lie). A repo whose ROOT tsconfig globs every file but defines NO `paths` alias, with a NESTED
// package tsconfig that DOES (`"*":["./src/*"]`), makes the primary program unable to resolve the
// alias-imports — so a read anchored at a component declaration finds ZERO usages and an agent deletes
// live code. Two complementary fixes, both pinned here:
//   A) file-driven nearest-config discovery: the decl's nearest enclosing tsconfig (the nested one
//      that resolves the alias) is loaded lazily as an extra read program and the cross-program
//      fan-out merges its references — so the usages/importers are FOUND.
//   B) honest floor: when a repo tsconfig is NOT loaded (a consumer living under a config the
//      nearest-config discovery did not reach), find_usages/importers_of report `complete:false` +
//      the NAMED config — never a confident `0` over a possibly-incomplete search.
//
// Oracle (§16): a fresh-from-cold `ts.LanguageService` built over the NESTED tsconfig (the program
// that resolves the alias) is the independent ground-truth file set; the warm fan-out anchors on the
// loose ROOT primary, so the two TS views are independent. Each correctness claim is ALSO pinned by a
// hand-curated file set (the canonical find_usages oracle, §16 — cold findReferences alone is
// circular when it is the same program).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import { createTsProjectHost } from '../../src/plugins/ts/ls-host.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const COMPILER =
  '"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx","skipLibCheck":true';

// Loose root: globs every file, NO `paths` alias → its program cannot resolve `components/...`.
// Nested app config: declares the `*` alias the consumers import through. The consumers live UNDER
// the nested config, so loading it (fix A) makes the search provably complete.
const LOOSE_ROOT = {
  'tsconfig.json': `{"compilerOptions":{${COMPILER}},"include":["app"]}`,
  'app/tsconfig.json': `{"extends":"../tsconfig.json","compilerOptions":{"baseUrl":"./src","paths":{"*":["./*"]}},"include":["src"]}`,
  'app/src/components/Text/Text.tsx':
    'export const Text = (p: { children?: unknown }) => <span>{p.children as never}</span>;\n',
  'app/src/App.tsx':
    "import { Text } from 'components/Text/Text';\nexport const App = () => <Text>hi</Text>;\n",
  'app/src/pages/Page.tsx':
    "import { Text } from 'components/Text/Text';\nexport const Page = () => <Text>page</Text>;\n",
};

type Usage = { span: { file: string; line: number; col: number }; role: string };
function usagesOf(r: OpResult): Usage[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  return (r.result.data as { usages?: Usage[] }).usages ?? [];
}
const fileSet = (u: Usage[]): string[] => [...new Set(u.map((x) => x.span.file))].sort();

test('find_usages: a component used ONLY through a nested-tsconfig path alias is found (loose-root primary cannot resolve it) — fix A', async () => {
  const p: TestProject = await project(LOOSE_ROOT);
  try {
    const u = usagesOf(
      await p.op('find_usages', {
        name: 'Text',
        file: 'app/src/components/Text/Text.tsx',
        collapseImports: false,
      }),
    );
    // Hand-curated ground truth (the canonical §16 oracle): the alias consumers ARE found, not just
    // the declaration. Before fix A this set was [Text.tsx] only — the fatal confident-0-ish lie.
    assert.deepEqual(
      fileSet(u),
      ['app/src/App.tsx', 'app/src/components/Text/Text.tsx', 'app/src/pages/Page.tsx'],
      'usages span both alias consumers + the decl',
    );

    // Independent cold oracle over the NESTED config (the program that resolves the alias) — a
    // DIFFERENT TS build than the warm fan-out anchored on the loose root primary.
    const oracle = coldFindReferences(
      p.root,
      'app/src/components/Text/Text.tsx',
      'Text',
      'app/tsconfig.json',
    );
    assert.deepEqual(fileSet(u), oracle, 'warm fan-out file set == cold nested-config oracle');
  } finally {
    await p.dispose();
  }
});

test('importers_of: a module imported ONLY through a nested-tsconfig alias finds its importers (loose-root primary resolves them under the wrong options) — fix A', async () => {
  const p: TestProject = await project(LOOSE_ROOT);
  try {
    const r = await p.op('importers_of', { module: 'app/src/components/Text/Text.tsx' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const at = (r.result.data as { importers?: { at: string }[] }).importers ?? [];
    const files = at.map((i) => i.at.slice(0, i.at.lastIndexOf(':'))).sort();
    assert.deepEqual(
      files,
      ['app/src/App.tsx', 'app/src/pages/Page.tsx'],
      'both alias importers found (was 0 — primary scanned them under aliasless root options)',
    );
  } finally {
    await p.dispose();
  }
});

test('cold == warm across the file-driven loaded state: a re-query after warm equals a cold boot over the nested config', async () => {
  const p: TestProject = await project(LOOSE_ROOT);
  try {
    // Warm the file-driven state (this loads the nested program), then re-query — the warm answer
    // must equal a fresh cold build over the nested config (no incremental drift in the loaded state).
    usagesOf(await p.op('find_usages', { name: 'Text', file: 'app/src/components/Text/Text.tsx' }));
    const again = usagesOf(
      await p.op('find_usages', {
        name: 'Text',
        file: 'app/src/components/Text/Text.tsx',
        collapseImports: false,
      }),
    );
    const oracle = coldFindReferences(
      p.root,
      'app/src/components/Text/Text.tsx',
      'Text',
      'app/tsconfig.json',
    );
    assert.deepEqual(
      fileSet(again),
      oracle,
      'warm (file-driven loaded) == cold nested-config boot',
    );
  } finally {
    await p.dispose();
  }
});

test('floor: a usage living under an UNDISCOVERED config (not reached by nearest-config discovery) → find_usages reports complete:false + the named config, never a confident 0 — fix B', async () => {
  // The decl's nearest enclosing config is the ROOT (primary), so fix A loads nothing; the consumer
  // lives under a NESTED package config neither adjacent to root nor referenced → undiscovered. The
  // usage there is NOT searched, so the answer MUST be flagged incomplete (machine-readable), not a
  // confident lower bound dressed as complete.
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${COMPILER}},"include":["src"]}`,
    'packages/app/tsconfig.json': `{"compilerOptions":{${COMPILER}}}`,
    'src/lib.ts':
      'export const widget = 1;\nexport const usedHere = 2;\nexport const consume = () => usedHere;\n',
    'packages/app/main.ts': "import { widget } from '../../src/lib';\nexport const z = widget;\n",
  });
  try {
    const r = await p.op('find_usages', { name: 'widget', file: 'src/lib.ts' });
    assert.ok('result' in r && r.result.ok, JSON.stringify(r));
    const data = r.result.data as { complete?: boolean; undiscoveredPrograms?: string[] };

    // The machine-readable verdict a count-only consumer reads WITHOUT parsing prose.
    assert.equal(data.complete, false, 'set-level incompleteness flag is present (not a silent 0)');
    assert.deepEqual(
      data.undiscoveredPrograms,
      ['packages/app/tsconfig.json'],
      'the unsearched config is NAMED (proof of why incomplete)',
    );

    // Independent cold oracle over the undiscovered config proves the usage IS real there — so a
    // confident "1 usage, complete" would have been the exact fatal lie this floor prevents.
    const oracle = coldFindReferences(p.root, 'src/lib.ts', 'widget', 'packages/app/tsconfig.json');
    assert.deepEqual(
      oracle,
      ['packages/app/main.ts', 'src/lib.ts'],
      'cold ground truth: widget IS used from the undiscovered program',
    );
  } finally {
    await p.dispose();
  }
});

test('§19 laziness: ensureProgramFor is idempotent + per-dir memoized — repeated reads do NOT grow the program set or re-walk; a target under the PRIMARY loads nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-nearest-'));
  try {
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{"compilerOptions":{${COMPILER}},"include":["app"]}`,
    );
    mkdirSync(path.join(dir, 'app', 'src', 'components'), { recursive: true });
    writeFileSync(
      path.join(dir, 'app', 'tsconfig.json'),
      `{"extends":"../tsconfig.json","compilerOptions":{"baseUrl":"./src","paths":{"*":["./*"]}},"include":["src"]}`,
    );
    writeFileSync(
      path.join(dir, 'app', 'src', 'components', 'Text.tsx'),
      'export const Text = 1;\n',
    );
    writeFileSync(path.join(dir, 'app', 'src', 'root.ts'), 'export const r = 1;\n');

    const host = createTsProjectHost(dir);
    try {
      const baseline = host.programs().length; // primary (+ any adjacent siblings)
      const declAbs = path.posix.join(dir, 'app/src/components/Text.tsx');

      host.ensureProgramFor(declAbs);
      const afterFirst = host.programs().length;
      assert.equal(
        afterFirst,
        baseline + 1,
        'the nested config is loaded once as an extra program',
      );

      // Idempotent: a second call for the same file (and another file under the SAME nested config)
      // must NOT add another program — the per-config + per-dir memos absorb it.
      host.ensureProgramFor(declAbs);
      host.ensureProgramFor(path.posix.join(dir, 'app/src/root.ts'));
      assert.equal(
        host.programs().length,
        afterFirst,
        'repeat calls are a no-op (idempotent, memoized)',
      );
    } finally {
      host.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
