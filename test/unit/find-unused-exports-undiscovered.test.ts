// The §3.4 FLOOR against a false-`certain`-dead from an UNDISCOVERED program (multi-program Task G
// residual). Discovery loads the primary config + adjacent `tsconfig*.json` + `references` — a
// NESTED-package tsconfig (here `packages/app/tsconfig.json`, neither adjacent to the root config
// nor referenced) is NOT loaded as a program. An export used ONLY from that program reads as
// unreferenced in every LOADED program, so a `certain`-dead would be the cardinal lie (an agent
// deletes a live export). The floor demotes it to `partial` and NAMES the unloaded config (proof of
// WHY). A genuinely USED export (from the primary) is untouched — the floor only weakens a DEAD
// verdict, never re-flags a used symbol.
//
// Oracle = a cold LS built over the NESTED tsconfig (a program the warm daemon never loaded), an
// INDEPENDENT TS view proving the export is genuinely referenced there — never the warm fan-out
// (which by design does not search the undiscovered program), never grep, never golden-only (§16).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project } from '../helpers/project.ts';
import { coldFindReferences } from '../helpers/cold-ls.ts';

type Unused = { name: string; confidence: string; note?: string };
type View = { unused: Unused[]; undiscoveredPrograms?: string[] };

const FIXTURE = {
  'tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"},"include":["src"]}',
  // Nested package — its own tsconfig, NOT adjacent to the root config and NOT in `references`,
  // so codemaster never loads it as a program. Its file imports a `src` export.
  'packages/app/tsconfig.json':
    '{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler"}}',
  'packages/app/main.ts':
    "import { usedOnlyInPkg } from '../../src/lib';\nexport const z = usedOnlyInPkg;\n",
  'src/lib.ts':
    'export const usedOnlyInPkg = 1;\n' + // used ONLY from the undiscovered packages/app program
    'export const usedInPrimary = 2;\n' + // used within the primary program (src/app.ts)
    'export const deadEverywhere = 3;\n', // used nowhere — dead in every loaded program too
  'src/app.ts':
    "import { usedInPrimary } from './lib';\nexport const useIt = () => usedInPrimary;\n",
};

test('find_unused_exports: an export used only from an UNDISCOVERED nested tsconfig is demoted to partial (named), never a false certain-dead — and a used export is untouched', async () => {
  const p = await project(FIXTURE);
  try {
    const r = await p.op('find_unused_exports', {});
    assert.ok('result' in r && r.result.ok, 'op succeeds');
    const data = r.result.data as View;
    const row = (name: string): Unused | undefined => data.unused.find((u) => u.name === name);

    // Independent oracle: a cold LS over the NESTED tsconfig proves the export is genuinely
    // referenced there — so a `certain`-dead from the loaded-only programs would be a lie.
    const oracle = coldFindReferences(
      p.root,
      'src/lib.ts',
      'usedOnlyInPkg',
      'packages/app/tsconfig.json',
    );
    assert.deepEqual(
      oracle,
      ['packages/app/main.ts', 'src/lib.ts'],
      'cold ground truth: the export IS used from the undiscovered program',
    );

    // The floor: demoted to partial, NOT certain — the false-dead this fixes.
    assert.equal(
      row('usedOnlyInPkg')?.confidence,
      'partial',
      'used only from an undiscovered program → partial, never a false certain-dead',
    );
    // Proof-carrying: the note NAMES the unloaded config (the agent sees WHY it is partial).
    assert.match(
      row('usedOnlyInPkg')?.note ?? '',
      /packages\/app\/tsconfig\.json/,
      'the note names the specific undiscovered tsconfig',
    );
    // A genuinely-dead export is ALSO demoted (blunt floor — honest, an undiscovered program could
    // use it too); it is still surfaced, just flagged partial rather than dropped.
    assert.equal(
      row('deadEverywhere')?.confidence,
      'partial',
      'dead-everywhere demoted, not hidden',
    );

    // A USED export is never reported at all — the floor demotes a DEAD verdict's confidence, it
    // does not touch a proven-used symbol.
    assert.equal(
      row('usedInPrimary'),
      undefined,
      'a primary-used export stays used (not reported)',
    );

    // The result surfaces the unloaded config set for the renderer note.
    assert.deepEqual(
      data.undiscoveredPrograms,
      ['packages/app/tsconfig.json'],
      'the undiscovered program is reported on the view',
    );
  } finally {
    await p.dispose();
  }
});
