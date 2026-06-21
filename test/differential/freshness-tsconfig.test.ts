// §3.5 / §16: a tsconfig.json edit must reach the PRIMARY program, not just the siblings. A
// HIGH staleness bug (sweep 2026-06-21): `single.reindex` flagged STRUCTURAL only for a `.ts`-like
// path (`isTsLike` excludes `.json`), so a `tsconfig.json` change never re-ran `loadFileList` —
// the primary kept a stale `parsed.fileNames` (glob) AND stale `parsed.options`. The host already
// rebuilds siblings on a tsconfig change and forwards the changed set to `primary.reindex`, so the
// asymmetry lived entirely in `single.reindex`: a widened `include` (or a new `paths`) was silently
// dropped and the answer reported complete — the exact completeness lie §3 forbids.
//
// Both tests drive the real read-time git-freshness backstop (write tsconfig → commit → next op
// reindexes from `git diff`), with the watcher silent, and pin the warm answer to a cold ts.Program
// over the SAME (edited) tsconfig (cold == warm, §16) — never grep, never the warm LS against itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, type TestProject } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

type Usage = { span: { file: string; line: number }; role: string };

function usageFiles(r: OpResult): string[] {
  assert.ok('result' in r && r.result.ok, JSON.stringify(r));
  const usages = (r.result.data as { usages?: Usage[] }).usages ?? [];
  return [...new Set(usages.map((u) => u.span.file))].sort();
}

// ── file-list variant: a widened `include` brings a previously-excluded user into the program ──
test('a widened tsconfig `include` reaches the primary program — a once-excluded <Button/> user appears (never silent-stale)', async () => {
  const p: TestProject = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"},"include":["src"]}',
    'src/Button.tsx': 'export const Button = (p: { size: string }) => <button>{p.size}</button>;\n',
    // A primary (in-`src`) usage — present before AND after, so the op never hits an empty result.
    'src/home.tsx':
      'import { Button } from \'./Button\';\nexport const Home = () => <Button size="md" />;\n',
    // EXCLUDED by `include:["src"]` — its <Button/> is invisible until the config widens.
    'app/uses-button.tsx':
      'import { Button } from \'../src/Button\';\nexport const Uses = () => <Button size="lg" />;\n',
  });
  try {
    const before = usageFiles(
      await p.op('find_usages', { name: 'Button', collapseImports: false }),
    );
    assert.ok(before.includes('src/home.tsx'), 'the primary src usage is found');
    assert.ok(
      !before.includes('app/uses-button.tsx'),
      'the excluded app usage is correctly absent before the config widens',
    );

    // Widen the glob to also own `app/` — WITHOUT touching app/uses-button.tsx itself.
    p.write(
      'tsconfig.json',
      '{"compilerOptions":{"strict":true,"jsx":"react-jsx"},"include":["src","app"]}',
    );
    p.commit('widen tsconfig include to app');

    const after = usageFiles(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    assert.ok(
      after.includes('app/uses-button.tsx'),
      'after widening include, the app <Button/> user surfaces in the primary program (not silent-stale)',
    );

    // cold == warm: an independent cold ts.Program over the edited tsconfig is the ground truth.
    const oracle = coldFindReferences(p.root, 'src/Button.tsx', 'Button', 'tsconfig.json');
    assert.ok(oracle.includes('app/uses-button.tsx'), 'cold oracle confirms the app usage is real');
    assert.deepEqual(after, oracle, 'warm find_usages equals the cold ground truth after the edit');
  } finally {
    await p.dispose();
  }
});

// ── options variant: an edited `paths` re-reads compilerOptions (same file set, options-only) ──
test('an edited tsconfig `paths` reaches the primary program — an alias import resolves, same file set', async () => {
  const COMPILER = '"strict":true,"jsx":"react-jsx","module":"esnext","moduleResolution":"bundler"';
  const p: TestProject = await project({
    'tsconfig.json': `{"compilerOptions":{${COMPILER},"paths":{}},"include":["src"]}`,
    'src/Button.tsx': 'export const Button = (p: { size: string }) => <button>{p.size}</button>;\n',
    // Imports through an alias that does NOT resolve until `paths` is added — file set is fixed,
    // so ONLY a compilerOptions refresh (not a re-glob) can make this usage appear.
    'src/use-alias.tsx':
      'import { Button as Btn } from \'@app/Button\';\nexport const Uses = () => <Btn size="lg" />;\n',
  });
  try {
    const before = usageFiles(
      await p.op('find_usages', { name: 'Button', collapseImports: false }),
    );
    assert.ok(
      !before.includes('src/use-alias.tsx'),
      'the alias import does not resolve before `paths` is configured',
    );

    p.write(
      'tsconfig.json',
      `{"compilerOptions":{${COMPILER},"paths":{"@app/*":["./src/*"]}},"include":["src"]}`,
    );
    p.commit('add @app/* path mapping');

    const after = usageFiles(await p.op('find_usages', { name: 'Button', collapseImports: false }));
    assert.ok(
      after.includes('src/use-alias.tsx'),
      'after the paths edit, the aliased import resolves and the usage surfaces (options refreshed)',
    );

    const oracle = coldFindReferences(p.root, 'src/Button.tsx', 'Button', 'tsconfig.json');
    assert.deepEqual(after, oracle, 'warm equals cold ground truth after the options edit');
  } finally {
    await p.dispose();
  }
});
