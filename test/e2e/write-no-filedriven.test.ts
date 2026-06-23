// WRITE paths must NOT see the read-path file-driven nearest-config programs (§5-L2). `find_usages`
// loads a nested package's tsconfig lazily (so an alias-only usage is found); that program must
// never reach a MUTATION's edit-site computation — else the edit set is session-order-dependent
// (rename) or silently un-gated (change_signature), since the §2.8 typecheck gate runs over the
// BUILT programs only. The fix routes write fan-out through `builtContaining` (built-only) and makes
// `findReferencesAcross`'s file-driven load an explicit READ opt-in (`loadNearest`).
//
// These two cases are RED before the fix (a prior read changes / leaks into the write) and GREEN
// after. Oracle: the WRITE's own observable edit set (touched / diff) — compared cold-vs-warm
// (rename) and against the built-only ground truth (both), no grep, no golden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonValue } from '../../src/core/json.ts';
import { project } from '../helpers/project.ts';

const COMPILER =
  '"strict":true,"module":"esnext","moduleResolution":"bundler","jsx":"react-jsx","skipLibCheck":true';

// Loose root: globs every file, NO alias → its (primary) program cannot resolve `components/...` /
// `api`. Nested app config declares the `*` alias. The alias consumers therefore resolve ONLY in the
// file-driven nested program a read would load — never in the built (primary) program a write uses.
const COMPONENT_ROOT = {
  'tsconfig.json': `{"compilerOptions":{${COMPILER}},"include":["app"]}`,
  'app/tsconfig.json': `{"extends":"../tsconfig.json","compilerOptions":{"baseUrl":"./src","paths":{"*":["./*"]}},"include":["src"]}`,
  'app/src/components/Text/Text.tsx':
    'export const Text = (p: { children?: unknown }) => <span>{p.children as never}</span>;\n',
  'app/src/App.tsx':
    "import { Text } from 'components/Text/Text';\nexport const App = () => <Text>hi</Text>;\n",
};

type Proj = Awaited<ReturnType<typeof project>>;
type RenameEnvelope = { touched: string[]; typecheck: { clean: boolean } };
type ChangeEnvelope = { diff: string; typecheck: { clean: boolean } };

async function rename(p: Proj, args: JsonValue): Promise<RenameEnvelope> {
  const [r] = await p.request([{ name: 'rename_symbol', args }]);
  if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
  return r.result.data as unknown as RenameEnvelope;
}

test('rename_symbol: edit set is session-order-INDEPENDENT — a prior find_usages (which loads the file-driven nested program) does NOT add un-gated rename sites', async () => {
  // COLD: a fresh host renames without any prior read.
  const cold = await project(COMPONENT_ROOT);
  let coldTouched: string[];
  try {
    coldTouched = (
      await rename(cold, {
        name: 'Text',
        file: 'app/src/components/Text/Text.tsx',
        newName: 'Label',
      })
    ).touched
      .slice()
      .sort();
  } finally {
    await cold.dispose();
  }

  // WARM: a fresh host runs find_usages FIRST (loading the file-driven nested program that resolves
  // the alias) and THEN renames the same symbol.
  const warm = await project(COMPONENT_ROOT);
  let warmTouched: string[];
  try {
    const u = await warm.op('find_usages', {
      name: 'Text',
      file: 'app/src/components/Text/Text.tsx',
    });
    assert.ok('result' in u && u.result.ok, 'the warming read succeeds');
    warmTouched = (
      await rename(warm, {
        name: 'Text',
        file: 'app/src/components/Text/Text.tsx',
        newName: 'Label',
      })
    ).touched
      .slice()
      .sort();
  } finally {
    await warm.dispose();
  }

  // The invariant: identical edit set regardless of read history (§16 inv-3 on a mutation). Before
  // the fix, the warm rename also rewrote the alias `<Text/>` sites the loaded nested program
  // surfaced — sites the built-only §2.8 gate never validated.
  assert.deepEqual(warmTouched, coldTouched, 'rename touched set is session-order-independent');
  // And both are BUILT-only: the primary cannot resolve the alias, so only the decl file is touched
  // (the alias consumer App.tsx is NOT rewritten — that loose-root mutation completeness gap is a
  // separate, consistently-cold backlog item, NOT an un-gated session-dependent edit).
  assert.deepEqual(
    coldTouched,
    ['app/src/components/Text/Text.tsx'],
    'built-only: the alias consumer is not in the edit set',
  );
});

test('change_signature: edit set is BUILT-only — the file-driven nested program is never loaded, so an alias-only caller is not rewritten un-gated (cold == warm)', async () => {
  const FILES = {
    'tsconfig.json': `{"compilerOptions":{${COMPILER}},"include":["app"]}`,
    'app/tsconfig.json': `{"extends":"../tsconfig.json","compilerOptions":{"baseUrl":"./src","paths":{"*":["./*"]}},"include":["src"]}`,
    'app/src/api.ts': 'export const greet = (a: string, b: number): string => a + String(b);\n',
    // Imports `greet` through the NESTED alias — resolvable ONLY in the file-driven program.
    'app/src/use.ts': "import { greet } from 'api';\nexport const x = greet('hi', 3);\n",
  };
  async function change(p: Proj, warmFirst: boolean): Promise<ChangeEnvelope> {
    if (warmFirst) {
      const u = await p.op('find_usages', { name: 'greet', file: 'app/src/api.ts' });
      assert.ok('result' in u && u.result.ok, 'the warming read succeeds');
    }
    const [r] = await p.request([
      {
        name: 'change_signature',
        args: { name: 'greet', file: 'app/src/api.ts', reorder: [1, 0] },
      },
    ]);
    if (r === undefined || 'error' in r) assert.fail(`dispatch error: ${JSON.stringify(r)}`);
    assert.ok(r.result.ok, `expected ok, got ${JSON.stringify(r)}`);
    return r.result.data as unknown as ChangeEnvelope;
  }

  const cold = await project(FILES);
  let coldDiff: string;
  try {
    const d = await change(cold, false);
    coldDiff = d.diff;
    // The decl IS rewritten (the op ran); the alias caller is NOT (built-only — the nested program
    // that resolves `from 'api'` was never loaded into this mutation). Before the fix, gatherSigRefs
    // unconditionally loaded it and rewrote use.ts — an edit the built-only gate never validated.
    assert.match(coldDiff, /app\/src\/api\.ts/, 'the declaration file is rewritten');
    assert.doesNotMatch(coldDiff, /app\/src\/use\.ts/, 'the alias-only caller is NOT rewritten');
  } finally {
    await cold.dispose();
  }

  const warm = await project(FILES);
  try {
    const warmDiff = (await change(warm, true)).diff;
    assert.equal(
      warmDiff,
      coldDiff,
      'change_signature diff is identical with or without a prior read',
    );
  } finally {
    await warm.dispose();
  }
});
