// t-679091 — the pre-warm guard for heavy SEMANTIC fan-out ops (find_usages / impact /
// importers_of, and find_definition when bare-name-addressed). The real failure (an OOM warming a
// repo-wide reference fan-out that kills the in-process daemon) can't be reproduced in a unit
// fixture, so these test the GATE behaviour hermetically: a low `ts.searchWarmMaxFiles` over a small
// fixture drives every branch, and the ts-plugin freshness fingerprint ('cold' iff no program was
// built) is the independent oracle that a refusal warmed nothing. The project() harness runs
// in-process (isolation:'in-process'), which is exactly where the guard fires.
//
// The discriminating pair: find_definition {name} (bare-name → repo-wide navto fan) IS refused,
// while find_definition {name+file} / {file+line+col} (single-program-exact) is NOT — the addressing
// predicate is the real logic, not a blanket "find_definition never refused".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

const config = (max: number): string =>
  `import { defineConfig } from 'codemaster';\n` +
  `export default defineConfig({ ts: { searchWarmMaxFiles: ${max} } });\n`;

// Two importers of src/a.ts so find_usages/importers_of have real fan-out to do (were the guard off).
const FILES = (max: number): Record<string, string> => ({
  'codemaster.config.ts': config(max),
  'tsconfig.json': '{"compilerOptions":{"strict":true}}',
  'src/a.ts': 'export const Widget = 1;\n',
  'src/b.ts': "import { Widget } from './a';\nexport const b = Widget + 1;\n",
  'src/c.ts': "import { Widget } from './a';\nexport const c = Widget + 2;\n",
});

const refused = (r: OpResult): boolean =>
  'result' in r && !r.result.ok && r.result.failure.tool === 'size-guard';
const ok = (r: OpResult): boolean => 'result' in r && r.result.ok;

async function tsFingerprint(p: Awaited<ReturnType<typeof project>>): Promise<string | undefined> {
  const status = await p.orchestrator.status(p.root, p.root);
  return status.workspace?.plugins.find((x) => x.id === 'ts')?.fingerprint;
}

test('over threshold, in-process: find_usages / impact / importers_of REFUSE + redirect to isolation:process, LS stays COLD', async () => {
  const p = await project(FILES(1));
  try {
    for (const req of [
      { name: 'find_usages', args: { name: 'Widget' } },
      { name: 'impact', args: { name: 'Widget' } },
      { name: 'importers_of', args: { module: 'src/a.ts' } },
    ] as const) {
      const res = await p.op(req.name, req.args);
      assert.ok(refused(res), `${req.name} must refuse over threshold: ${JSON.stringify(res)}`);
      if ('result' in res && !res.result.ok) {
        const msg = res.result.failure.message;
        assert.match(msg, /isolation/, `${req.name} redirect names isolation:process`);
        assert.match(msg, /process/, `${req.name} redirect names process-mode`);
        assert.match(msg, /force:true/, `${req.name} redirect names the force override`);
        assert.match(
          msg,
          /\d+ source files > threshold 1/,
          `${req.name} states count vs threshold`,
        );
      }
    }
    // The load-bearing discriminant: a refused fan-out warmed nothing → the ts plugin stays cold.
    assert.equal(await tsFingerprint(p), 'cold', 'a refused fan-out must not warm the LS');
  } finally {
    await p.dispose();
  }
});

test('find_definition addressing predicate: fan-capable {name} / {symbolId} REFUSE; single-program {name+file} / {file+line+col} do NOT', async () => {
  const p = await project(FILES(1));
  try {
    // Bare name → resolveByName → repo-wide navto fan → guarded.
    const byName = await p.op('find_definition', { name: 'Widget' });
    assert.ok(refused(byName), `bare-name find_definition must refuse: ${JSON.stringify(byName)}`);

    // symbolId → resolveSymbolId, whose §6 rebind branch (a moved-file handle) fans navto across all
    // programs → guarded. The op can't tell pre-resolve whether a rebind is needed, so all symbolId
    // lookups are guarded in-process-oversized (a false refusal redirects honestly to process-mode).
    const bySymbolId = await p.op('find_definition', { symbolId: 'ts:Widget@src/a.ts:1:14' });
    assert.ok(
      refused(bySymbolId),
      `symbolId find_definition (rebind can fan) must refuse: ${JSON.stringify(bySymbolId)}`,
    );

    // name+file → resolveNameInFile (single program, no fan) → NOT guarded.
    const byNameFile = await p.op('find_definition', { name: 'Widget', file: 'src/a.ts' });
    assert.ok(
      ok(byNameFile),
      `name+file find_definition must resolve: ${JSON.stringify(byNameFile)}`,
    );

    // file+line+col → exact position (single program) → NOT guarded. `export const Widget` → col 14.
    const byPos = await p.op('find_definition', { file: 'src/a.ts', line: 1, col: 14 });
    assert.ok(ok(byPos), `file+line+col find_definition must resolve: ${JSON.stringify(byPos)}`);
  } finally {
    await p.dispose();
  }
});

test('force:true bypasses the guard over threshold (find_usages warms and answers)', async () => {
  const p = await project(FILES(1));
  try {
    const res = await p.op('find_usages', { name: 'Widget', force: true });
    assert.ok(ok(res), `force:true must warm and answer, not refuse: ${JSON.stringify(res)}`);
    assert.notEqual(await tsFingerprint(p), 'cold', 'force:true warms the LS');
  } finally {
    await p.dispose();
  }
});

test('below threshold: find_usages runs normally (no false refusal)', async () => {
  const p = await project(FILES(100));
  try {
    const res = await p.op('find_usages', { name: 'Widget' });
    assert.ok(ok(res), `under threshold must not refuse: ${JSON.stringify(res)}`);
  } finally {
    await p.dispose();
  }
});
