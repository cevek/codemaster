// Spec-kitchensink Stage 4 — oracle hardening. Closes the review's three weak kitchensink
// oracles, pinning codemaster's HONEST behavior (spec §5 Stage 4). This is the companion to
// kitchensink-traps.test.ts (the spec says "extend" it; the 300-line-per-file cap forced the
// split). Each `expected` is HAND-CURATED by reading the fixture (spec §2.1); failures are
// surfaced per the failure discipline (§2) and audited in docs/findings-kitchensink.md.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { projectFromDir } from '../helpers/repo-fixture.ts';
import { coldDiagnostics } from '../helpers/cold-ls.ts';
import type { TestProject } from '../helpers/project.ts';
import type { OpResult } from '../../src/ops/contracts.ts';

// Narrow an OpResult to its success payload, asserting ok along the way.
function okData(r: OpResult): Record<string, unknown> {
  assert.ok('result' in r, `dispatch error: ${JSON.stringify(r)}`);
  assert.ok(r.result.ok, `op failed: ${JSON.stringify(r.result)}`);
  return r.result.data as Record<string, unknown>;
}

void describe('kitchensink Stage 4 — oracle hardening (S12 composes · S5 demotion · M9)', () => {
  let p: TestProject;
  before(async () => {
    p = await projectFromDir('kitchensink');
  });
  after(async () => {
    await p.dispose();
  });

  type UnusedRow = { name: string; file: string; confidence: string };
  const unusedRows = async (proj: TestProject): Promise<UnusedRow[]> =>
    okData(await proj.op('find_unused_scss_classes', {}))['unused'] as UnusedRow[];

  // S5 — a class DECLARED but never statically referenced in a module that ALSO has dynamic css
  // access (`table.module.scss`: `s[dynamicKey]`). The dynamic access demotes the WHOLE module's
  // unused-claims, so `.active` (no static ref) can't be proven dead → `partial`, never `certain`
  // unused. (Contrast the grid/theme modules, which have no dynamic access → `certain`.)
  test('S5 — declared-unreferenced class in a dynamic-access module is `partial`, not certain-unused', async () => {
    const rows = await unusedRows(p);
    const active = rows.find((u) => u.name === 'active' && u.file.includes('table.module.scss'));
    assert.equal(
      active?.confidence,
      'partial',
      'dynamic css access (s[expr]) demotes the whole module — .active is not provably dead',
    );
  });

  // S12 (KS-4) — the ISOLABLE composes target. `composeBase` (grid.module.scss) is reachable
  // ONLY via the `composes:` linkage from `composeConsumer` (which IS used in Dashboard); it is
  // never referenced directly. grid has no dynamic access, so an over-eager scan would call it
  // `certain` unused. spec-scss-css-honesty Stage 1 closes KS-4: find_unused now consults the
  // `composes:` linkage, so `composeBase` is `partial` ("reachable via composes:"), never
  // plainly certain-unused — acting on a certain claim would delete the class and break the
  // composition.
  test('S12 (KS-4) — a composes-only class is partial, never plainly certain-unused', async () => {
    const rows = await unusedRows(p);
    const base = rows.find((u) => u.name === 'composeBase' && u.file.includes('grid.module.scss'));
    // Counted used (absent) or honestly `partial` — never plainly `certain` unused.
    assert.ok(
      base === undefined || base.confidence !== 'certain',
      'composes-reachable class must not read as certain-unused',
    );
    if (base !== undefined) assert.equal(base.confidence, 'partial', 'reachable → partial');
    // The directly-used composer itself is correctly NOT unused (sanity: the trap is isolated).
    assert.ok(
      !rows.some((u) => u.name === 'composeConsumer'),
      'composeConsumer is used in Dashboard — must not read as unused',
    );
  });

  // M9 (move side) — a module behind the string-keyed lazy registry. Moving Table.tsx (a
  // registry target) must rewrite the dynamic `import('@/features/table/Table.tsx')` specifier in
  // lazy.ts, not just the static importers. The cold full-program compile is the completeness
  // gate (a dangling dynamic specifier resolves to nothing).
  test('M9 — move rewrites the lazy-registry dynamic import() specifier', async () => {
    const q = await projectFromDir('kitchensink');
    try {
      const [r] = await q.request([
        {
          name: 'move_file',
          args: {
            source: 'src/features/table/Table.tsx',
            dest: 'src/features/table/DataTable.tsx',
          },
          apply: true,
        },
      ]);
      assert.ok(
        r !== undefined && 'result' in r && r.result.ok,
        `move failed: ${JSON.stringify(r)}`,
      );
      assert.deepEqual(coldDiagnostics(q.root), []);
      assert.match(
        readFileSync(path.join(q.root, 'src/features/forms/lazy.ts'), 'utf8'),
        /import\(['"]@\/features\/table\/DataTable\.tsx['"]\)/,
      );
    } finally {
      await q.dispose();
    }
  });

  // M9 (rename side) — the spec (§5 Stage 4) anticipated an honest-LIMITATION here: "a symbol
  // rename that can't reach the string path is flagged". That limitation DOES NOT ARISE in this
  // fixture, and the absence is itself the finding: TS reaches the registry's dynamic-import
  // MEMBER access (`m.Widget` → `m.Gadget`) and stays compile-clean, and the ONLY string is the
  // module PATH — which a symbol rename correctly leaves untouched (renaming the symbol doesn't
  // move the file; rewriting the path is move_file's job, proven above). So there is nothing
  // incomplete to flag: the op is honest by reaching every semantic ref and not faking path
  // surgery. (A genuine "can't reach a string" case would need the symbol's NAME embedded in a
  // string literal — which this registry does not have; it uses a real `m.Widget` member access.)
  test('M9 — rename reaches the dynamic-import member; leaves the path string to move_file (honest)', async () => {
    const q = await projectFromDir('kitchensink');
    try {
      const [r] = await q.request([
        { name: 'rename_symbol', args: { name: 'Widget', newName: 'Gadget' }, apply: true },
      ]);
      assert.ok(
        r !== undefined && 'result' in r && r.result.ok,
        `rename failed: ${JSON.stringify(r)}`,
      );
      assert.equal(
        (r.result.data as unknown as { typecheck: { clean: boolean } }).typecheck.clean,
        true,
      );
      assert.deepEqual(coldDiagnostics(q.root), []);
      const lazy = readFileSync(path.join(q.root, 'src/features/forms/lazy.ts'), 'utf8');
      assert.match(lazy, /m\.Gadget/); // the member access was reached and renamed
      assert.doesNotMatch(lazy, /m\.Widget/);
      assert.match(lazy, /@\/features\/widget\/Widget\.tsx/); // the path STRING is correctly left intact
    } finally {
      await q.dispose();
    }
  });
});
